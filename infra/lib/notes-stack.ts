import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib'
import type { Construct } from 'constructs'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2'
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

export interface NotesStackProps extends StackProps {
  /** e.g. notes.example.com */
  siteDomain: string
  /** The Route 53 zone the site domain lives in, e.g. example.com */
  hostedZone: string
  /** Globally unique prefix for the Cognito sign-in page. */
  authDomainPrefix: string
}

export class NotesStack extends Stack {
  constructor(scope: Construct, id: string, props: NotesStackProps) {
    super(scope, id, props)
    const { siteDomain } = props
    const siteUrl = `https://${siteDomain}`
    const devUrl = 'http://localhost:5173'

    // ---- Data: one table, one partition per user (see services/api/src/handler.ts).
    const table = new dynamodb.TableV2(this, 'Data', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        { indexName: 'bySeq', partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'seq', type: dynamodb.AttributeType.NUMBER } },
      ],
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    })

    const files = new s3.Bucket(this, 'Files', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      cors: [{ allowedMethods: [s3.HttpMethods.PUT], allowedOrigins: [siteUrl, devUrl], allowedHeaders: ['content-type'] }],
    })

    // ---- Sign-in: only accounts created by the owner; no self sign-up.
    const users = new cognito.UserPool(this, 'Users', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { otp: true, sms: false },
      passwordPolicy: { minLength: 12 },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.RETAIN,
    })
    const authDomain = users.addDomain('SignIn', { cognitoDomain: { domainPrefix: props.authDomainPrefix } })
    const client = users.addClient('Web', {
      generateSecret: false,
      authFlows: { userSrp: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL],
        callbackUrls: [`${siteUrl}/`, `${devUrl}/`],
        logoutUrls: [`${siteUrl}/`, `${devUrl}/`],
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
    })

    // ---- API: one Lambda behind an HTTP API, reached through CloudFront at /api.
    const fn = new NodejsFunction(this, 'Api', {
      entry: path.join(root, 'services/api/src/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName, FILES_BUCKET: files.bucketName },
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      bundling: { format: OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true },
    })
    table.grantReadWriteData(fn)
    files.grantReadWrite(fn)

    const api = new apigw.HttpApi(this, 'Http', { createDefaultStage: true })
    const auth = new HttpJwtAuthorizer('Jwt', `https://cognito-idp.${this.region}.amazonaws.com/${users.userPoolId}`, {
      jwtAudience: [client.userPoolClientId],
    })
    const integration = new HttpLambdaIntegration('Fn', fn)
    for (const [method, route] of [
      [apigw.HttpMethod.GET, '/api/sync'],
      [apigw.HttpMethod.POST, '/api/sync'],
      [apigw.HttpMethod.POST, '/api/uploads'],
    ] as const) {
      api.addRoutes({ path: route, methods: [method], integration, authorizer: auth })
    }
    api.addRoutes({ path: '/api/files/{owner}/{name}', methods: [apigw.HttpMethod.GET], integration })

    // ---- Web: static files in S3 behind CloudFront on the site domain.
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.hostedZone })
    const cert = new acm.Certificate(this, 'Cert', { domainName: siteDomain, validation: acm.CertificateValidation.fromDns(zone) })
    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })
    // Paths without a file extension are app routes: serve index.html for them.
    const spa = new cloudfront.Function(this, 'SpaRewrite', {
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(
        "function handler(e){var r=e.request;if(!/\\.[a-z0-9]+$/i.test(r.uri)){r.uri='/index.html';}return r;}",
      ),
    })
    const cdn = new cloudfront.Distribution(this, 'Cdn', {
      domainNames: [siteDomain],
      certificate: cert,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [{ function: spa, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    })
    new route53.ARecord(this, 'SiteA', { zone, recordName: siteDomain, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(cdn)) })
    new route53.AaaaRecord(this, 'SiteAaaa', { zone, recordName: siteDomain, target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(cdn)) })

    new s3deploy.BucketDeployment(this, 'Deploy', {
      destinationBucket: site,
      distribution: cdn,
      sources: [
        s3deploy.Source.asset(path.join(root, 'apps/web/dist')),
        // Read by the app at start-up, so the build never needs these values.
        s3deploy.Source.jsonData('config.json', {
          region: this.region,
          clientId: client.userPoolClientId,
          authUrl: authDomain.baseUrl(),
        }),
      ],
    })

    new CfnOutput(this, 'Url', { value: siteUrl })
    new CfnOutput(this, 'UserPoolId', { value: users.userPoolId })
  }
}
