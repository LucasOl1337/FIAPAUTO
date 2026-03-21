import { Amplify } from 'aws-amplify'
import { fetchAuthSession, getCurrentUser, signIn, signOut } from 'aws-amplify/auth'

const cognitoConfig = {
  region: import.meta.env.VITE_COGNITO_REGION ?? '',
  userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '',
  userPoolClientId: import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID ?? '',
}

let configured = false

export function isCognitoConfigured() {
  return Boolean(cognitoConfig.region && cognitoConfig.userPoolId && cognitoConfig.userPoolClientId)
}

export function configureCognito() {
  if (configured || !isCognitoConfigured()) {
    return
  }

  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId: cognitoConfig.userPoolId,
        userPoolClientId: cognitoConfig.userPoolClientId,
      },
    },
  })

  configured = true
}

export async function getAccessToken() {
  if (!isCognitoConfigured()) {
    return ''
  }

  configureCognito()
  const session = await fetchAuthSession()
  return session.tokens?.accessToken?.toString() ?? ''
}

export async function getSignedInUserLabel() {
  if (!isCognitoConfigured()) {
    return ''
  }

  configureCognito()
  const user = await getCurrentUser()
  return user.signInDetails?.loginId ?? user.username
}

export async function signInWithPassword(username: string, password: string) {
  configureCognito()
  return signIn({
    username,
    password,
  })
}

export async function signOutCurrentUser() {
  if (!isCognitoConfigured()) {
    return
  }

  configureCognito()
  await signOut()
}
