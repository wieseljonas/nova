export type AuthScheme =
  | "bearer"
  | "basic"
  | "header"
  | "query"
  | "oauth_client"
  | "google_service_account";

export interface SecretPayloadInput {
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  secret?: string;
  clientId?: string;
  clientSecret?: string;
  tokenUrl?: string;
  serviceAccountJson?: string;
}
