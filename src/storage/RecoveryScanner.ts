import { StorageIntegrityService } from "./IntegrityService";

/** Named recovery boundary used by startup/on-demand storage scans. */
export class RecoveryScanner extends StorageIntegrityService {}
