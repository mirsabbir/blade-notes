import { App } from 'aws-cdk-lib'
import { NotesStack } from '../lib/notes-stack'

/** Everything specific to one deployment comes from the environment (see .env.example), never from the code. */
function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Set ${name} (copy .env.example to .env)`)
  return v
}

const app = new App()
new NotesStack(app, 'BladeNotes', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  siteDomain: need('NOTES_DOMAIN'),
  hostedZone: need('NOTES_HOSTED_ZONE'),
  authDomainPrefix: need('NOTES_AUTH_PREFIX'),
  alertEmail: process.env.NOTES_ALERT_EMAIL,
})
