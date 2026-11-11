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
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventTargets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { DynamoEventSource } from 'aws-cdk-lib/aws-lambda-event-sources'
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as subs from 'aws-cdk-lib/aws-sns-subscriptions'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')

export interface NotesStackProps extends StackProps {
  /** e.g. notes.example.com */
  siteDomain: string
  /** The Route 53 zone the site domain lives in, e.g. example.com */
  hostedZone: string
  /** Globally unique prefix for the Cognito sign-in page. */
  authDomainPrefix: string
  /** Where security alerts go (key disabled, root sign-in). No alerts without it. */
  alertEmail?: string
}

export class NotesStack extends Stack {
  constructor(scope: Construct, id: string, props: NotesStackProps) {
    super(scope, id, props)
    const { siteDomain } = props
    const siteUrl = `https://${siteDomain}`
    const devUrl = 'http://localhost:5173'

    // ---- One KMS key encrypts everything stored: table, files, logs, calendar sign-ins.
    // Every use is in CloudTrail; disabling it locks the data at once. AWS makes and rotates
    // the key material; a key you bring yourself can replace it later without downtime.
    const key = new kms.Key(this, 'DataKey', {
      alias: 'alias/blade-notes',
      description: 'Blade Notes: notes table, files, logs and calendar sign-ins',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    })
    key.addToResourcePolicy(
      new iam.PolicyStatement({
        principals: [new iam.ServicePrincipal(`logs.${this.region}.amazonaws.com`)],
        actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'],
        resources: ['*'],
        conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${this.region}:${this.account}:log-group:*` } },
      }),
    )

    // ---- Data: one table, one partition per user (see services/api/src/handler.ts).
    const table = new dynamodb.TableV2(this, 'Data', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      globalSecondaryIndexes: [
        { indexName: 'bySeq', partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING }, sortKey: { name: 'seq', type: dynamodb.AttributeType.NUMBER } },
      ],
      billing: dynamodb.Billing.onDemand(),
      encryption: dynamodb.TableEncryptionV2.customerManagedKey(key),
      // The calendar worker follows item changes; short-lived records (sign-in state) expire by `ttl`.
      dynamoStream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    })

    const files = new s3.Bucket(this, 'Files', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: key,
      bucketKeyEnabled: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // POST: uploads. GET: the app fetches a file with a short signed link after asking /api/files.
      cors: [{ allowedMethods: [s3.HttpMethods.POST, s3.HttpMethods.GET], allowedOrigins: [siteUrl, devUrl], allowedHeaders: ['*'] }],
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
        // COGNITO_ADMIN lets the signed-in user set up two-step sign-in and sign out everywhere from Settings.
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.COGNITO_ADMIN],
        callbackUrls: [`${siteUrl}/`, `${devUrl}/`],
        logoutUrls: [`${siteUrl}/`, `${devUrl}/`],
      },
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
    })

    // ---- API: one Lambda behind an HTTP API, reached through CloudFront at /api.
    const fn = new NodejsFunction(this, 'Api', {
      entry: path.join(root, 'services/api/src/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { TABLE_NAME: table.tableName, FILES_BUCKET: files.bucketName },
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_MONTH, encryptionKey: key, removalPolicy: RemovalPolicy.DESTROY }),
      bundling: { format: OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true, externalModules: [], banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
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
      [apigw.HttpMethod.GET, '/api/files/{owner}/{name}'],
    ] as const) {
      api.addRoutes({ path: route, methods: [method], integration, authorizer: auth })
    }

    // ---- Calendar sync: /api/calendar routes plus a worker on the table's stream that writes
    // dated items into each space's calendar (services/calendar). OAuth app credentials live
    // in SSM under /blade-notes/; calendar sign-ins are sealed with the KMS key.
    const calendar = new NodejsFunction(this, 'Calendar', {
      entry: path.join(root, 'services/calendar/src/handler.ts'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(30),
      environment: {
        TABLE_NAME: table.tableName,
        KEY_ID: key.keyArn,
        SITE_URL: siteUrl,
        GOOGLE_PARAM: '/blade-notes/google-oauth',
        MICROSOFT_PARAM: '/blade-notes/microsoft-oauth',
      },
      logGroup: new logs.LogGroup(this, 'CalendarLogs', { retention: logs.RetentionDays.ONE_MONTH, encryptionKey: key, removalPolicy: RemovalPolicy.DESTROY }),
      bundling: { format: OutputFormat.ESM, target: 'node22', minify: true, sourceMap: true, externalModules: [], banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    })
    table.grantReadWriteData(calendar)
    key.grantEncryptDecrypt(calendar)
    calendar.addToRolePolicy(
      new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/blade-notes/*`] }),
    )
    calendar.addEventSource(
      new DynamoEventSource(table, {
        startingPosition: lambda.StartingPosition.LATEST,
        batchSize: 25,
        bisectBatchOnError: true,
        reportBatchItemFailures: true,
        retryAttempts: 3,
        maxRecordAge: Duration.hours(1),
        filters: [lambda.FilterCriteria.filter({ dynamodb: { Keys: { sk: { S: lambda.FilterRule.beginsWith('ITEM#') } } } })],
      }),
    )
    const calendarRoutes = new HttpLambdaIntegration('CalendarFn', calendar)
    for (const [method, route] of [
      [apigw.HttpMethod.GET, '/api/calendar'],
      [apigw.HttpMethod.POST, '/api/calendar/connect'],
      [apigw.HttpMethod.POST, '/api/calendar/disconnect'],
      [apigw.HttpMethod.POST, '/api/calendar/resync'],
    ] as const) {
      api.addRoutes({ path: route, methods: [method], integration: calendarRoutes, authorizer: auth })
    }
    // Google and Microsoft send the browser back here after sign-in; the one-time state is the key.
    api.addRoutes({ path: '/api/calendar/callback', methods: [apigw.HttpMethod.GET], integration: calendarRoutes })

    // ---- Web: static files in S3 behind CloudFront on the site domain.
    const zone = route53.HostedZone.fromLookup(this, 'Zone', { domainName: props.hostedZone })
    const cert = new acm.Certificate(this, 'Cert', { domainName: siteDomain, validation: acm.CertificateValidation.fromDns(zone) })
    const site = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    })
    // Browser hardening on every response. Scripts only from this site; styles may be inline
    // (React style props, the editor); network only to this site, sign-in and the files bucket.
    const authOrigin = `https://${props.authDomainPrefix}.auth.${this.region}.amazoncognito.com`
    const csp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:", // pasted web images still show
      "font-src 'self'",
      `connect-src 'self' ${authOrigin} https://cognito-idp.${this.region}.amazonaws.com https://${files.bucketRegionalDomainName} https://${files.bucketName}.s3.amazonaws.com`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join('; ')
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      securityHeadersBehavior: {
        strictTransportSecurity: { accessControlMaxAge: Duration.days(730), includeSubdomains: true, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true }],
      },
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
        responseHeadersPolicy: headers,
        functionAssociations: [{ function: spa, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.amazonaws.com`),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: headers,
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

    if (props.alertEmail) this.alerts(key, props.alertEmail)

    new CfnOutput(this, 'Url', { value: siteUrl })
    new CfnOutput(this, 'UserPoolId', { value: users.userPoolId })
  }

  /**
   * Email when someone disables or schedules deletion of a KMS key, changes a key policy,
   * or signs in as the AWS root user. EventBridge sees these only through a trail,
   * so a small write-only trail (its first copy is free) records management events.
   */
  private alerts(key: kms.Key, email: string) {
    const topic = new sns.Topic(this, 'Alerts', { displayName: 'Blade Notes security alert' })
    topic.addSubscription(new subs.EmailSubscription(email))
    const logBucket = new s3.Bucket(this, 'TrailLogs', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [{ expiration: Duration.days(365) }],
      removalPolicy: RemovalPolicy.RETAIN,
    })
    new cloudtrail.Trail(this, 'Trail', {
      bucket: logBucket,
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: true,
      managementEvents: cloudtrail.ReadWriteType.WRITE_ONLY,
    })
    const say = (text: string) =>
      new eventTargets.SnsTopic(topic, {
        message: events.RuleTargetInput.fromText(
          `${text}\n\nWho: ${events.EventField.fromPath('$.detail.userIdentity.arn')}\nFrom: ${events.EventField.fromPath('$.detail.sourceIPAddress')}\nWhen: ${events.EventField.time}\nKey: ${key.keyArn}`,
        ),
      })
    new events.Rule(this, 'KeyAlarm', {
      eventPattern: {
        source: ['aws.kms'],
        detailType: ['AWS API Call via CloudTrail'],
        detail: { eventName: ['DisableKey', 'ScheduleKeyDeletion', 'PutKeyPolicy', 'DeleteImportedKeyMaterial'] },
      },
      targets: [say(`Blade Notes: a KMS key was disabled, scheduled for deletion or had its policy changed (${events.EventField.fromPath('$.detail.eventName')}).`)],
    })
    new events.Rule(this, 'RootSignInAlarm', {
      eventPattern: { detailType: ['AWS Console Sign In via CloudTrail'], detail: { userIdentity: { type: ['Root'] } } },
      targets: [say('Blade Notes: someone signed in to the AWS account as the root user.')],
    })
  }
}
