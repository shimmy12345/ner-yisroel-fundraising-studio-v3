export interface DonationImportChangeRow {
  source_fingerprint: string;
  change_type: "insert" | "update" | string;
  previous_json: string | null;
}

export interface CurrentGivingActivityRow {
  source_fingerprint: string;
  donor_id: string;
  donor_name: string;
  activity_date: number;
  amount_cents: number;
  paid_cents: number | null;
  balance_cents: number | null;
  category: string | null;
  description: string | null;
  source_snapshot: string | null;
}

export interface RestorableGivingState {
  source_fingerprint: string;
  paid_cents: number | null;
  balance_cents: number | null;
  category: string | null;
  source_snapshot: string | null;
}

export interface DonationRollbackPreview {
  safe: boolean;
  blockers: string[];
  newGifts: Array<{
    sourceFingerprint: string;
    donorId: string;
    donorName: string;
    activityDate: number;
    amountCents: number;
    description: string | null;
  }>;
  pledgeUpdates: Array<{
    sourceFingerprint: string;
    donorId: string;
    donorName: string;
    activityDate: number;
    description: string | null;
    currentPaidCents: number | null;
    restoredPaidCents: number | null;
    currentBalanceCents: number | null;
    restoredBalanceCents: number | null;
    currentStatus: string | null;
    restoredStatus: string | null;
  }>;
  totals: {
    newGiftsRemoved: number;
    pledgeUpdatesRestored: number;
    balancesRestored: number;
    statusesRestored: number;
  };
  restoreStates: RestorableGivingState[];
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function parsePreviousState(change: DonationImportChangeRow): RestorableGivingState | null {
  if (!change.previous_json) return null;
  try {
    const value = JSON.parse(change.previous_json) as Record<string, unknown>;
    const paid = nullableNumber(value.paid_cents);
    const balance = nullableNumber(value.balance_cents);
    const category = nullableString(value.category);
    const snapshot = nullableString(value.source_snapshot);
    if (paid === undefined || balance === undefined || category === undefined || snapshot === undefined) {
      return null;
    }
    return {
      source_fingerprint: change.source_fingerprint,
      paid_cents: paid,
      balance_cents: balance,
      category,
      source_snapshot: snapshot,
    };
  } catch {
    return null;
  }
}

export function buildDonationRollbackPreview(
  changes: DonationImportChangeRow[],
  currentRows: CurrentGivingActivityRow[],
): DonationRollbackPreview {
  const blockers: string[] = [];
  const currentByFingerprint = new Map(currentRows.map((row) => [row.source_fingerprint, row]));
  const newGifts: DonationRollbackPreview["newGifts"] = [];
  const pledgeUpdates: DonationRollbackPreview["pledgeUpdates"] = [];
  const restoreStates: RestorableGivingState[] = [];

  if (changes.length === 0) blockers.push("This batch has no recorded database changes to reverse.");

  for (const change of changes) {
    const current = currentByFingerprint.get(change.source_fingerprint);
    if (!current) {
      blockers.push(`A gift changed by this batch is no longer present (${change.source_fingerprint.slice(0, 12)}…).`);
      continue;
    }

    if (change.change_type === "insert") {
      newGifts.push({
        sourceFingerprint: change.source_fingerprint,
        donorId: current.donor_id,
        donorName: current.donor_name,
        activityDate: current.activity_date,
        amountCents: current.amount_cents,
        description: current.description,
      });
      continue;
    }

    if (change.change_type === "update") {
      const previous = parsePreviousState(change);
      if (!previous) {
        blockers.push(`The stored before-values are incomplete for ${change.source_fingerprint.slice(0, 12)}….`);
        continue;
      }
      restoreStates.push(previous);
      pledgeUpdates.push({
        sourceFingerprint: change.source_fingerprint,
        donorId: current.donor_id,
        donorName: current.donor_name,
        activityDate: current.activity_date,
        description: current.description,
        currentPaidCents: current.paid_cents,
        restoredPaidCents: previous.paid_cents,
        currentBalanceCents: current.balance_cents,
        restoredBalanceCents: previous.balance_cents,
        currentStatus: current.category,
        restoredStatus: previous.category,
      });
      continue;
    }

    blockers.push(`The batch contains an unsupported change type: ${change.change_type}.`);
  }

  return {
    safe: blockers.length === 0,
    blockers,
    newGifts,
    pledgeUpdates,
    totals: {
      newGiftsRemoved: newGifts.length,
      pledgeUpdatesRestored: pledgeUpdates.length,
      balancesRestored: pledgeUpdates.filter((row) => row.currentBalanceCents !== row.restoredBalanceCents).length,
      statusesRestored: pledgeUpdates.filter((row) => row.currentStatus !== row.restoredStatus).length,
    },
    restoreStates,
  };
}
