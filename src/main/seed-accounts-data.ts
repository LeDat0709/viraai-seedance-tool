/// <reference types="vite/client" />

export interface SeedanceExportPool {
  id: string
  ten: string
  tao_luc?: number
}

export interface SeedanceExportAccount {
  id?: string
  name?: string
  cookies: Record<string, string> | string
  enabled?: boolean
  proxy?: string
  nguon?: string
  fb_uid?: string
  dola_uid?: string
  kho?: string
  created_at?: number
  dung_xong?: boolean
  dung_xong_luc?: number
  dung_xong_ly_do?: string
  dung_xong_ip?: string
}

export interface SeedanceAccountsExportPayload {
  loai?: string
  phien_ban?: number
  xuat_luc?: number
  kho?: SeedanceExportPool[]
  tai_khoan: SeedanceExportAccount[]
}

// Cookie acc thật nằm ở local-seed/accounts.json (gitignore). Thiếu file → seed rỗng, build vẫn chạy.
const localSeed = import.meta.glob<SeedanceAccountsExportPayload>('./local-seed/accounts.json', {
  eager: true,
  import: 'default'
})

export const DEFAULT_SEEDANCE_ACCOUNTS_DATA: SeedanceAccountsExportPayload = localSeed[
  './local-seed/accounts.json'
] ?? { loai: 'seedance-accounts', phien_ban: 1, kho: [], tai_khoan: [] }
