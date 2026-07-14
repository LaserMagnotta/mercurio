// Machine-readable API error codes the UI maps to copy (`apiErrors.<code>`
// in the message catalogs). A LEAF module (no React, no next-intl) so the
// unit test can walk it against both catalogs in a plain node environment.

export const KNOWN_API_ERROR_CODES = [
  'network_error',
  'http_401',
  'rate_limited',
  'conflict',
  'illegal_event',
  'wallet_unavailable',
  'wallet_required',
  'self_payment_impossible',
  'hub_not_found',
  'hubs_too_close',
  'sender_owns_hub',
  'bond_above_cap',
  'parcel_too_big',
  'parcel_too_heavy',
  'undeclared_not_accepted',
  'hub_storage_too_short',
  'trip_not_found',
  'trip_not_active',
  'trip_expires_before_departure',
  'carrier_role_required',
  'not_at_hub',
  'not_the_sender',
  'fake_wallets_disabled',
  'nwc_not_implemented',
  'preview_pair_required',
  'pool_exhausted',
  'progress_below_minimum',
] as const;
