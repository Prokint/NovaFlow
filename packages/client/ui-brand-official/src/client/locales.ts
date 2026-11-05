/** NovaFlow brand and desktop-account dictionaries. */

export const NS = 'novaflow'

/** Simplified Chinese NovaFlow messages. */
export const zh = {
  'brand.name': 'NovaFlow',
  'account.signIn': '登录 NovaFlow',
  'account.signingIn': '正在登录…',
  'account.open': 'NovaFlow 账号',
} satisfies Record<string, string>

/** Translation keys owned by the NovaFlow namespace. */
export type NovaFlowKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** NovaFlow brand and desktop-account copy. */
    novaflow: NovaFlowKey
  }
}

/** English NovaFlow messages. */
export const en = {
  'brand.name': 'NovaFlow',
  'account.signIn': 'Sign in to NovaFlow',
  'account.signingIn': 'Signing in…',
  'account.open': 'NovaFlow account',
} satisfies Record<NovaFlowKey, string>

/** ja NovaFlow messages. */
export const ja = {
  'brand.name': 'NovaFlow',
  'account.signIn': 'NovaFlow にログイン',
  'account.signingIn': 'ログイン中…',
  'account.open': 'NovaFlow アカウント',
} satisfies Record<NovaFlowKey, string>

/** es NovaFlow messages. */
export const es = {
  'brand.name': 'NovaFlow',
  'account.signIn': 'Iniciar sesión en NovaFlow',
  'account.signingIn': 'Iniciando sesión…',
  'account.open': 'Cuenta de NovaFlow',
} satisfies Record<NovaFlowKey, string>

/** fr NovaFlow messages. */
export const fr = {
  'brand.name': 'NovaFlow',
  'account.signIn': 'Se connecter à NovaFlow',
  'account.signingIn': 'Connexion…',
  'account.open': 'Compte NovaFlow',
} satisfies Record<NovaFlowKey, string>

/** de NovaFlow messages. */
export const de = {
  'brand.name': 'NovaFlow',
  'account.signIn': 'Bei NovaFlow anmelden',
  'account.signingIn': 'Anmeldung läuft…',
  'account.open': 'NovaFlow-Konto',
} satisfies Record<NovaFlowKey, string>

/** ru NovaFlow messages. */
export const ru = {
  'brand.name': 'NovaFlow',
  'account.signIn': 'Войти в NovaFlow',
  'account.signingIn': 'Вход…',
  'account.open': 'Аккаунт NovaFlow',
} satisfies Record<NovaFlowKey, string>

/** pt NovaFlow messages. */
export const pt = {
  'brand.name': 'NovaFlow',
  'account.signIn': 'Entrar no NovaFlow',
  'account.signingIn': 'Entrando…',
  'account.open': 'Conta NovaFlow',
} satisfies Record<NovaFlowKey, string>
