// Pure logic for the "Google access may expire" notice. In Testing status
// Google expires refresh tokens 7 days after issue.

export const TESTING_TOKEN_LIFETIME_DAYS = 7;

export interface OAuthNoticeDetails {
  publishing_status?: string;
  token_issued_at?: string;
}

export interface OAuthNoticeState {
  /** Show the warning at all. */
  visible: boolean;
  expiresAt: Date | null;
  /** Whole days left (never below 0); null when the issue date is unknown. */
  daysLeft: number | null;
  /** Within 48 hours of expiry (or already past): resurfaces after dismissal. */
  urgent: boolean;
}

export function computeOAuthNotice(
  details: OAuthNoticeDetails,
  dismissedAt: string | null,
  now: Date,
): OAuthNoticeState {
  if (details.publishing_status !== "testing") {
    return { visible: false, expiresAt: null, daysLeft: null, urgent: false };
  }
  const issued = details.token_issued_at
    ? new Date(details.token_issued_at)
    : null;
  const valid = issued && !Number.isNaN(issued.getTime());
  const expiresAt = valid
    ? new Date(issued.getTime() + TESTING_TOKEN_LIFETIME_DAYS * 86_400_000)
    : null;
  const msLeft = expiresAt ? expiresAt.getTime() - now.getTime() : null;
  const urgent = msLeft !== null && msLeft <= 48 * 3_600_000;
  return {
    visible: !dismissedAt || urgent,
    expiresAt,
    daysLeft:
      msLeft === null ? null : Math.max(0, Math.floor(msLeft / 86_400_000)),
    urgent,
  };
}
