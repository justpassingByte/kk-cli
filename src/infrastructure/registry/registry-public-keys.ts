import type { RegistryPublicKeys } from '../../domain/registry/manifest-signature.js';

// Public verification material is embedded so released CLIs fail closed even
// when process environment variables are absent.
export const DEFAULT_REGISTRY_PUBLIC_KEYS: RegistryPublicKeys = new Map([
  ['prod-2026-07', '2BqPs8im/RDp9XX7xirKCV4QCO7kNbkGXMt6iat2r1s='],
]);
