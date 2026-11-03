/** Production NovaFlow service origin, shared by the main process and the account dialog. */

/** Production NovaFlow service, used until the user chooses another New API server. */
export const DEFAULT_NOVAFLOW_ORIGIN = 'https://api.lanjiaotrade.com'

/** Desktop model access is supplied exclusively by the signed-in NovaFlow account. */
export const NOVAFLOW_ACCESS_MODE = 'desktop-account' as const
