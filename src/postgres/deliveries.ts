import { Pool, type PoolClient } from 'pg';
import {
  AppError,
  type AcknowledgeDeliveryInput,
  type BearerTokenSummary,
  type ClaimDeliveryInput,
  type ClaimedDelivery,
  type CompleteDeliveryAttemptInput,
  type CreateBearerTokenInput,
  type CreateDeliveryEndpointInput,
  type CreatedBearerToken,
  type DeliveryAcknowledgement,
  type DeliveryAttemptInspection,
  type DeliveryAttemptSummary,
  type DeliveryEndpointState,
  type DeliveryEndpointSummary,
  type DeliverySummary,
  type ListDeliveriesInput,
  type ListDeliveryAttemptsInput,
  type PendingDelivery,
  type Repository,
  type RetryDeliveryInput,
  type RevokeBearerTokenInput,
  type RevokeDeliveryEndpointInput,
  type UpdateDeliveryEndpointInput,
  type FailDeliveryAttemptInput,
} from '../app.ts';
import { buildBearerToken } from '../token.ts';

type DbClient = Pool | PoolClient;

type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  options?: { deliveryWorkerScope?: boolean },
) => Promise<void>;

type WithActorContext = <T>(
  pool: Pool,
  actorMemberId: string,
  networkIds: string[],
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

type DeliverySummaryRow = {
  delivery_id: string;
  network_id: string;
  recipient_member_id: string;
  endpoint_id: string;
  topic: string;
  payload: Record<string, unknown> | null;
  status: 'pending' | 'processing' | 'sent' | 'failed' | 'canceled';
  attempt_count: number;
  entity_id: string | null;
  entity_version_id: string | null;
  transcript_message_id: string | null;
  scheduled_at: string;
  sent_at: string | null;
  failed_at: string | null;
  last_error: string | null;
  created_at: string;
  acknowledgement_id: string | null;
  acknowledgement_state: 'shown' | 'suppressed' | null;
  acknowledgement_suppression_reason: string | null;
  acknowledgement_version_no: number | null;
  acknowledgement_created_at: string | null;
  acknowledgement_created_by_member_id: string | null;
};

type PendingDeliveryRow = {
  id: string;
  network_id: string;
  entity_id: string | null;
  entity_version_id: string | null;
  transcript_message_id: string | null;
  topic: string;
  payload: Record<string, unknown> | null;
  created_at: string;
  sent_at: string | null;
};

type DeliveryEndpointRow = {
  endpoint_id: string;
  member_id: string;
  channel: 'openclaw_webhook';
  label: string | null;
  endpoint_url: string;
  shared_secret_ref: string | null;
  state: DeliveryEndpointState;
  last_success_at: string | null;
  last_failure_at: string | null;
  pending_count: number | string | null;
  processing_count: number | string | null;
  sent_count: number | string | null;
  failed_count: number | string | null;
  canceled_count: number | string | null;
  last_delivery_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  disabled_at: string | null;
};

type BearerTokenRow = {
  token_id: string;
  member_id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  metadata: Record<string, unknown> | null;
};

type DeliveryAcknowledgementRow = {
  acknowledgement_id: string;
  delivery_id: string;
  network_id: string;
  recipient_member_id: string;
  state: DeliveryAcknowledgement['state'];
  suppression_reason: string | null;
  version_no: number;
  supersedes_acknowledgement_id: string | null;
  created_at: string;
  created_by_member_id: string | null;
};

type DeliveryAttemptRow = {
  attempt_id: string;
  delivery_id: string;
  network_id: string | null;
  endpoint_id: string;
  worker_key: string | null;
  status: DeliveryAttemptSummary['status'];
  attempt_no: number;
  response_status_code: number | null;
  response_body: string | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  created_by_member_id: string | null;
};

type DeliveryAttemptInspectionRow = DeliveryAttemptRow & {
  delivery_network_id: string;
  delivery_recipient_member_id: string;
  recipient_public_name: string;
  recipient_handle: string | null;
  delivery_topic: string;
  delivery_status: DeliverySummary['status'];
  delivery_attempt_count: number;
  delivery_scheduled_at: string;
  delivery_sent_at: string | null;
  delivery_failed_at: string | null;
  delivery_last_error: string | null;
  delivery_created_at: string;
};

function mapPendingDeliveryRow(row: PendingDeliveryRow): PendingDelivery {
  return {
    deliveryId: row.id,
    networkId: row.network_id,
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    transcriptMessageId: row.transcript_message_id,
    topic: row.topic,
    payload: row.payload ?? {},
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

function mapDeliverySummaryRow(row: DeliverySummaryRow): DeliverySummary {
  return {
    deliveryId: row.delivery_id,
    networkId: row.network_id,
    recipientMemberId: row.recipient_member_id,
    endpointId: row.endpoint_id,
    topic: row.topic,
    payload: row.payload ?? {},
    status: row.status,
    attemptCount: Number(row.attempt_count ?? 0),
    entityId: row.entity_id,
    entityVersionId: row.entity_version_id,
    transcriptMessageId: row.transcript_message_id,
    scheduledAt: row.scheduled_at,
    sentAt: row.sent_at,
    failedAt: row.failed_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    acknowledgement:
      row.acknowledgement_id && row.acknowledgement_state && row.acknowledgement_version_no && row.acknowledgement_created_at
        ? {
            acknowledgementId: row.acknowledgement_id,
            state: row.acknowledgement_state,
            suppressionReason: row.acknowledgement_suppression_reason,
            versionNo: Number(row.acknowledgement_version_no),
            createdAt: row.acknowledgement_created_at,
            createdByMemberId: row.acknowledgement_created_by_member_id,
          }
        : null,
  };
}

function mapDeliveryEndpointRow(row: DeliveryEndpointRow): DeliveryEndpointSummary {
  return {
    endpointId: row.endpoint_id,
    memberId: row.member_id,
    channel: row.channel,
    label: row.label,
    endpointUrl: row.endpoint_url,
    sharedSecretRef: row.shared_secret_ref,
    state: row.state,
    lastSuccessAt: row.last_success_at,
    lastFailureAt: row.last_failure_at,
    health: {
      pendingCount: Number(row.pending_count ?? 0),
      processingCount: Number(row.processing_count ?? 0),
      sentCount: Number(row.sent_count ?? 0),
      failedCount: Number(row.failed_count ?? 0),
      canceledCount: Number(row.canceled_count ?? 0),
      lastDeliveryAt: row.last_delivery_at,
    },
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    disabledAt: row.disabled_at,
  };
}

function mapBearerTokenRow(row: BearerTokenRow): BearerTokenSummary {
  return {
    tokenId: row.token_id,
    memberId: row.member_id,
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    metadata: row.metadata ?? {},
  };
}

function mapDeliveryAcknowledgementRow(row: DeliveryAcknowledgementRow): DeliveryAcknowledgement {
  return {
    acknowledgementId: row.acknowledgement_id,
    deliveryId: row.delivery_id,
    networkId: row.network_id,
    recipientMemberId: row.recipient_member_id,
    state: row.state,
    suppressionReason: row.suppression_reason,
    versionNo: Number(row.version_no),
    supersedesAcknowledgementId: row.supersedes_acknowledgement_id,
    createdAt: row.created_at,
    createdByMemberId: row.created_by_member_id,
  };
}

function mapDeliveryAttemptRow(row: DeliveryAttemptRow): DeliveryAttemptSummary {
  return {
    attemptId: row.attempt_id,
    deliveryId: row.delivery_id,
    networkId: row.network_id,
    endpointId: row.endpoint_id,
    workerKey: row.worker_key,
    status: row.status,
    attemptNo: Number(row.attempt_no),
    responseStatusCode: row.response_status_code === null ? null : Number(row.response_status_code),
    responseBody: row.response_body,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdByMemberId: row.created_by_member_id,
  };
}

function mapDeliveryAttemptInspectionRow(row: DeliveryAttemptInspectionRow): DeliveryAttemptInspection {
  return {
    attempt: mapDeliveryAttemptRow(row),
    delivery: {
      deliveryId: row.delivery_id,
      networkId: row.delivery_network_id,
      recipientMemberId: row.delivery_recipient_member_id,
      endpointId: row.endpoint_id,
      topic: row.delivery_topic,
      status: row.delivery_status,
      attemptCount: Number(row.delivery_attempt_count),
      scheduledAt: row.delivery_scheduled_at,
      sentAt: row.delivery_sent_at,
      failedAt: row.delivery_failed_at,
      lastError: row.delivery_last_error,
      createdAt: row.delivery_created_at,
      recipient: {
        memberId: row.delivery_recipient_member_id,
        publicName: row.recipient_public_name,
        handle: row.recipient_handle,
      },
    },
  };
}

export async function listPendingDeliveries(client: DbClient, actorMemberId: string, accessibleNetworkIds: string[]): Promise<PendingDelivery[]> {
  if (accessibleNetworkIds.length === 0) {
    return [];
  }

  const result = await client.query<PendingDeliveryRow>(
    `
      select
        pd.id,
        pd.network_id,
        pd.entity_id,
        pd.entity_version_id,
        pd.transcript_message_id,
        pd.topic,
        pd.payload,
        pd.created_at::text as created_at,
        pd.sent_at::text as sent_at
      from app.pending_deliveries pd
      where pd.recipient_member_id = $1
        and pd.network_id = any($2::app.short_id[])
      order by coalesce(pd.sent_at, pd.created_at) asc, pd.id asc
    `,
    [actorMemberId, accessibleNetworkIds],
  );

  return result.rows.map(mapPendingDeliveryRow);
}

async function loadDeliveryEndpoint(client: DbClient, endpointId: string): Promise<DeliveryEndpointSummary | null> {
  const result = await client.query<DeliveryEndpointRow>(
    `
      select
        de.id as endpoint_id,
        de.member_id,
        de.channel,
        de.label,
        de.endpoint_url,
        de.shared_secret_ref,
        de.state,
        de.last_success_at::text,
        de.last_failure_at::text,
        de.metadata,
        de.created_at::text,
        de.disabled_at::text
      from app.delivery_endpoints de
      where de.id = $1
      limit 1
    `,
    [endpointId],
  );

  const row = result.rows[0];
  return row ? mapDeliveryEndpointRow(row) : null;
}

async function loadDeliverySummary(client: DbClient, deliveryId: string): Promise<DeliverySummary | null> {
  const result = await client.query<DeliverySummaryRow>(
    `
      select
        cdr.delivery_id,
        cdr.network_id,
        cdr.recipient_member_id,
        cdr.endpoint_id,
        cdr.topic,
        cdr.payload,
        cdr.status,
        cdr.attempt_count,
        cdr.entity_id,
        cdr.entity_version_id,
        cdr.transcript_message_id,
        cdr.scheduled_at::text as scheduled_at,
        cdr.sent_at::text as sent_at,
        cdr.failed_at::text as failed_at,
        cdr.last_error,
        cdr.created_at::text as created_at,
        cdr.acknowledgement_id,
        cdr.acknowledgement_state,
        cdr.acknowledgement_suppression_reason,
        cdr.acknowledgement_version_no,
        cdr.acknowledgement_created_at::text as acknowledgement_created_at,
        cdr.acknowledgement_created_by_member_id
      from app.current_delivery_receipts cdr
      where cdr.delivery_id = $1
    `,
    [deliveryId],
  );

  return result.rows[0] ? mapDeliverySummaryRow(result.rows[0]) : null;
}

async function loadCurrentDeliveryAttempt(client: DbClient, deliveryId: string): Promise<DeliveryAttemptSummary | null> {
  const result = await client.query<DeliveryAttemptRow>(
    `
      select
        cda.id as attempt_id,
        cda.delivery_id,
        cda.network_id,
        cda.endpoint_id,
        cda.worker_key,
        cda.status,
        cda.attempt_no,
        cda.response_status_code,
        cda.response_body,
        cda.error_message,
        cda.started_at::text as started_at,
        cda.finished_at::text as finished_at,
        cda.created_by_member_id
      from app.current_delivery_attempts cda
      where cda.delivery_id = $1
    `,
    [deliveryId],
  );

  return result.rows[0] ? mapDeliveryAttemptRow(result.rows[0]) : null;
}

async function readDeliveries(client: DbClient, input: ListDeliveriesInput): Promise<DeliverySummary[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<DeliverySummaryRow>(
    `
      select
        cdr.delivery_id,
        cdr.network_id,
        cdr.recipient_member_id,
        cdr.endpoint_id,
        cdr.topic,
        cdr.payload,
        cdr.status,
        cdr.attempt_count,
        cdr.entity_id,
        cdr.entity_version_id,
        cdr.transcript_message_id,
        cdr.scheduled_at::text as scheduled_at,
        cdr.sent_at::text as sent_at,
        cdr.failed_at::text as failed_at,
        cdr.last_error,
        cdr.created_at::text as created_at,
        cdr.acknowledgement_id,
        cdr.acknowledgement_state,
        cdr.acknowledgement_suppression_reason,
        cdr.acknowledgement_version_no,
        cdr.acknowledgement_created_at::text as acknowledgement_created_at,
        cdr.acknowledgement_created_by_member_id
      from app.current_delivery_receipts cdr
      where cdr.recipient_member_id = $1
        and cdr.network_id = any($2::app.short_id[])
        and ($3::boolean = false or cdr.acknowledgement_id is null)
      order by coalesce(cdr.sent_at, cdr.created_at) desc, cdr.delivery_id desc
      limit $4
    `,
    [input.actorMemberId, input.networkIds, input.pendingOnly, input.limit],
  );

  return result.rows.map(mapDeliverySummaryRow);
}

async function readDeliveryAttempts(client: DbClient, input: ListDeliveryAttemptsInput): Promise<DeliveryAttemptInspection[]> {
  if (input.networkIds.length === 0) {
    return [];
  }

  const result = await client.query<DeliveryAttemptInspectionRow>(
    `
      select
        da.id as attempt_id,
        da.delivery_id,
        da.network_id,
        da.endpoint_id,
        da.worker_key,
        da.status,
        da.attempt_no,
        da.response_status_code,
        da.response_body,
        da.error_message,
        da.started_at::text as started_at,
        da.finished_at::text as finished_at,
        da.created_by_member_id,
        d.network_id as delivery_network_id,
        d.recipient_member_id as delivery_recipient_member_id,
        m.public_name as recipient_public_name,
        m.handle as recipient_handle,
        d.topic as delivery_topic,
        d.status as delivery_status,
        d.attempt_count as delivery_attempt_count,
        d.scheduled_at::text as delivery_scheduled_at,
        d.sent_at::text as delivery_sent_at,
        d.failed_at::text as delivery_failed_at,
        d.last_error as delivery_last_error,
        d.created_at::text as delivery_created_at
      from app.delivery_attempts da
      join app.deliveries d on d.id = da.delivery_id
      join app.members m on m.id = d.recipient_member_id
      where d.network_id = any($1::app.short_id[])
        and ($2::app.short_id is null or da.endpoint_id = $2)
        and ($3::app.short_id is null or d.recipient_member_id = $3)
        and ($4::app.delivery_status is null or da.status = $4)
      order by da.started_at desc, da.delivery_id desc, da.attempt_no desc
      limit $5
    `,
    [input.networkIds, input.endpointId ?? null, input.recipientMemberId ?? null, input.status ?? null, input.limit],
  );

  return result.rows.map(mapDeliveryAttemptInspectionRow);
}

export function buildDeliveryRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  | 'listDeliveryEndpoints'
  | 'createDeliveryEndpoint'
  | 'updateDeliveryEndpoint'
  | 'revokeDeliveryEndpoint'
  | 'listBearerTokens'
  | 'createBearerToken'
  | 'revokeBearerToken'
  | 'listDeliveries'
  | 'listDeliveryAttempts'
  | 'retryDelivery'
  | 'acknowledgeDelivery'
  | 'claimNextDelivery'
  | 'completeDeliveryAttempt'
  | 'failDeliveryAttempt'
> {
  return {
    async listDeliveryEndpoints({ actorMemberId }: { actorMemberId: string }): Promise<DeliveryEndpointSummary[]> {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<DeliveryEndpointRow>(
          `
            select
              dep.id as endpoint_id,
              dep.member_id,
              dep.channel,
              dep.label,
              dep.endpoint_url,
              dep.shared_secret_ref,
              dep.state,
              dep.last_success_at::text as last_success_at,
              dep.last_failure_at::text as last_failure_at,
              coalesce(count(*) filter (where d.status = 'pending'), 0) as pending_count,
              coalesce(count(*) filter (where d.status = 'processing'), 0) as processing_count,
              coalesce(count(*) filter (where d.status = 'sent'), 0) as sent_count,
              coalesce(count(*) filter (where d.status = 'failed'), 0) as failed_count,
              coalesce(count(*) filter (where d.status = 'canceled'), 0) as canceled_count,
              max(d.created_at)::text as last_delivery_at,
              dep.metadata,
              dep.created_at::text as created_at,
              dep.disabled_at::text as disabled_at
            from app.delivery_endpoints dep
            left join app.deliveries d on d.endpoint_id = dep.id
            where dep.member_id = $1
            group by
              dep.id,
              dep.member_id,
              dep.channel,
              dep.label,
              dep.endpoint_url,
              dep.shared_secret_ref,
              dep.state,
              dep.last_success_at,
              dep.last_failure_at,
              dep.metadata,
              dep.created_at,
              dep.disabled_at
            order by dep.created_at desc, dep.id desc
          `,
          [actorMemberId],
        );

        return result.rows.map(mapDeliveryEndpointRow);
      });
    },

    async createDeliveryEndpoint(input: CreateDeliveryEndpointInput): Promise<DeliveryEndpointSummary> {
      return withActorContext(pool, input.actorMemberId, [], async (client) => {
        const result = await client.query<DeliveryEndpointRow>(
          `
            insert into app.delivery_endpoints (
              member_id,
              channel,
              label,
              endpoint_url,
              shared_secret_ref,
              metadata
            )
            values ($1, $2, $3, $4, $5, $6::jsonb)
            returning
              id as endpoint_id,
              member_id,
              channel,
              label,
              endpoint_url,
              shared_secret_ref,
              state,
              last_success_at::text as last_success_at,
              last_failure_at::text as last_failure_at,
              0 as pending_count,
              0 as processing_count,
              0 as sent_count,
              0 as failed_count,
              0 as canceled_count,
              null::text as last_delivery_at,
              metadata,
              created_at::text as created_at,
              disabled_at::text as disabled_at
          `,
          [
            input.actorMemberId,
            input.channel ?? 'openclaw_webhook',
            input.label ?? null,
            input.endpointUrl,
            input.sharedSecretRef ?? null,
            JSON.stringify(input.metadata ?? {}),
          ],
        );

        return mapDeliveryEndpointRow(result.rows[0]!);
      });
    },

    async updateDeliveryEndpoint(input: UpdateDeliveryEndpointInput): Promise<DeliveryEndpointSummary | null> {
      const fields: string[] = [];
      const params: unknown[] = [input.endpointId, input.actorMemberId];
      let nextIndex = params.length + 1;

      if (input.patch.label !== undefined) {
        fields.push(`label = $${nextIndex++}`);
        params.push(input.patch.label);
      }

      if (input.patch.endpointUrl !== undefined) {
        fields.push(`endpoint_url = $${nextIndex++}`);
        params.push(input.patch.endpointUrl);
      }

      if (input.patch.sharedSecretRef !== undefined) {
        fields.push(`shared_secret_ref = $${nextIndex++}`);
        params.push(input.patch.sharedSecretRef);
      }

      if (input.patch.state !== undefined) {
        fields.push(`state = $${nextIndex++}`);
        params.push(input.patch.state);
        fields.push(`disabled_at = ${input.patch.state === 'disabled' ? 'coalesce(disabled_at, now())' : 'null'}`);
      }

      if (input.patch.metadata !== undefined) {
        fields.push(`metadata = $${nextIndex++}::jsonb`);
        params.push(JSON.stringify(input.patch.metadata));
      }

      return withActorContext(pool, input.actorMemberId, [], async (client) => {
        const result = await client.query<DeliveryEndpointRow>(
          `
            update app.delivery_endpoints dep
            set ${fields.join(', ')}
            where dep.id = $1
              and dep.member_id = $2
            returning
              dep.id as endpoint_id,
              dep.member_id,
              dep.channel,
              dep.label,
              dep.endpoint_url,
              dep.shared_secret_ref,
              dep.state,
              dep.last_success_at::text as last_success_at,
              dep.last_failure_at::text as last_failure_at,
              0 as pending_count,
              0 as processing_count,
              0 as sent_count,
              0 as failed_count,
              0 as canceled_count,
              null::text as last_delivery_at,
              dep.metadata,
              dep.created_at::text as created_at,
              dep.disabled_at::text as disabled_at
          `,
          params,
        );

        return result.rows[0] ? mapDeliveryEndpointRow(result.rows[0]) : null;
      });
    },

    async revokeDeliveryEndpoint(input: RevokeDeliveryEndpointInput): Promise<DeliveryEndpointSummary | null> {
      return withActorContext(pool, input.actorMemberId, [], async (client) => {
        const result = await client.query<DeliveryEndpointRow>(
          `
            update app.delivery_endpoints dep
            set state = 'disabled',
                disabled_at = coalesce(dep.disabled_at, now())
            where dep.id = $1
              and dep.member_id = $2
            returning
              dep.id as endpoint_id,
              dep.member_id,
              dep.channel,
              dep.label,
              dep.endpoint_url,
              dep.shared_secret_ref,
              dep.state,
              dep.last_success_at::text as last_success_at,
              dep.last_failure_at::text as last_failure_at,
              0 as pending_count,
              0 as processing_count,
              0 as sent_count,
              0 as failed_count,
              0 as canceled_count,
              null::text as last_delivery_at,
              dep.metadata,
              dep.created_at::text as created_at,
              dep.disabled_at::text as disabled_at
          `,
          [input.endpointId, input.actorMemberId],
        );

        return result.rows[0] ? mapDeliveryEndpointRow(result.rows[0]) : null;
      });
    },

    async listBearerTokens({ actorMemberId }: { actorMemberId: string }): Promise<BearerTokenSummary[]> {
      return withActorContext(pool, actorMemberId, [], async (client) => {
        const result = await client.query<BearerTokenRow>(
          `
            select
              mbt.id as token_id,
              mbt.member_id,
              mbt.label,
              mbt.created_at::text as created_at,
              mbt.last_used_at::text as last_used_at,
              mbt.revoked_at::text as revoked_at,
              mbt.metadata
            from app.member_bearer_tokens mbt
            where mbt.member_id = $1
            order by mbt.created_at desc, mbt.id desc
          `,
          [actorMemberId],
        );

        return result.rows.map(mapBearerTokenRow);
      });
    },

    async createBearerToken(input: CreateBearerTokenInput): Promise<CreatedBearerToken> {
      const token = buildBearerToken();
      return withActorContext(pool, input.actorMemberId, [], async (client) => {
        const result = await client.query<BearerTokenRow>(
          `
            insert into app.member_bearer_tokens (id, member_id, label, token_hash, metadata)
            values ($1, $2, $3, $4, $5::jsonb)
            returning
              id as token_id,
              member_id,
              label,
              created_at::text as created_at,
              last_used_at::text as last_used_at,
              revoked_at::text as revoked_at,
              metadata
          `,
          [token.tokenId, input.actorMemberId, input.label ?? null, token.tokenHash, JSON.stringify(input.metadata ?? {})],
        );

        return {
          token: mapBearerTokenRow(result.rows[0]!),
          bearerToken: token.bearerToken,
        };
      });
    },

    async revokeBearerToken(input: RevokeBearerTokenInput): Promise<BearerTokenSummary | null> {
      return withActorContext(pool, input.actorMemberId, [], async (client) => {
        const result = await client.query<BearerTokenRow>(
          `
            update app.member_bearer_tokens mbt
            set revoked_at = coalesce(mbt.revoked_at, now())
            where mbt.id = $1
              and mbt.member_id = $2
            returning
              mbt.id as token_id,
              mbt.member_id,
              mbt.label,
              mbt.created_at::text as created_at,
              mbt.last_used_at::text as last_used_at,
              mbt.revoked_at::text as revoked_at,
              mbt.metadata
          `,
          [input.tokenId, input.actorMemberId],
        );

        return result.rows[0] ? mapBearerTokenRow(result.rows[0]) : null;
      });
    },

    async listDeliveries(input: ListDeliveriesInput): Promise<DeliverySummary[]> {
      return withActorContext(pool, input.actorMemberId, input.networkIds, (client) => readDeliveries(client, input));
    },

    async listDeliveryAttempts(input: ListDeliveryAttemptsInput): Promise<DeliveryAttemptInspection[]> {
      return withActorContext(pool, input.actorMemberId, input.networkIds, (client) => readDeliveryAttempts(client, input));
    },

    async retryDelivery(input: RetryDeliveryInput): Promise<DeliverySummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const currentResult = await client.query<{
          delivery_id: string;
          network_id: string;
          recipient_member_id: string;
          endpoint_id: string;
          entity_id: string | null;
          entity_version_id: string | null;
          transcript_message_id: string | null;
          topic: string;
          payload: Record<string, unknown> | null;
          status: DeliverySummary['status'];
        }>(
          `
            select
              cdr.delivery_id,
              cdr.network_id,
              cdr.recipient_member_id,
              cdr.endpoint_id,
              cdr.entity_id,
              cdr.entity_version_id,
              cdr.transcript_message_id,
              cdr.topic,
              cdr.payload,
              cdr.status
            from app.current_delivery_receipts cdr
            where cdr.delivery_id = $1
              and cdr.recipient_member_id = $2
              and cdr.network_id = any($3::app.short_id[])
          `,
          [input.deliveryId, input.actorMemberId, input.accessibleNetworkIds],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        if (current.status !== 'failed' && current.status !== 'canceled') {
          throw new AppError(409, 'delivery_not_retryable', 'Only failed or canceled deliveries can be retried');
        }

        const insertedResult = await client.query<{ delivery_id: string }>(
          `
            insert into app.deliveries (
              network_id,
              recipient_member_id,
              endpoint_id,
              entity_id,
              entity_version_id,
              transcript_message_id,
              topic,
              payload,
              status,
              scheduled_at,
              attempt_count,
              last_error,
              sent_at,
              failed_at,
              dedupe_key
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'pending', now(), 0, null, null, null, null)
            returning id as delivery_id
          `,
          [
            current.network_id,
            current.recipient_member_id,
            current.endpoint_id,
            current.entity_id,
            current.entity_version_id,
            current.transcript_message_id,
            current.topic,
            JSON.stringify(current.payload ?? {}),
          ],
        );

        const retriedDeliveryId = insertedResult.rows[0]?.delivery_id;
        if (!retriedDeliveryId) {
          throw new Error('Retried delivery id missing after insert');
        }

        const reloadedResult = await client.query<DeliverySummaryRow>(
          `
            select
              cdr.delivery_id,
              cdr.network_id,
              cdr.recipient_member_id,
              cdr.endpoint_id,
              cdr.topic,
              cdr.payload,
              cdr.status,
              cdr.attempt_count,
              cdr.entity_id,
              cdr.entity_version_id,
              cdr.transcript_message_id,
              cdr.scheduled_at::text as scheduled_at,
              cdr.sent_at::text as sent_at,
              cdr.failed_at::text as failed_at,
              cdr.last_error,
              cdr.created_at::text as created_at,
              cdr.acknowledgement_id,
              cdr.acknowledgement_state,
              cdr.acknowledgement_suppression_reason,
              cdr.acknowledgement_version_no,
              cdr.acknowledgement_created_at::text as acknowledgement_created_at,
              cdr.acknowledgement_created_by_member_id
            from app.current_delivery_receipts cdr
            where cdr.delivery_id = $1
          `,
          [retriedDeliveryId],
        );

        await client.query('commit');
        return reloadedResult.rows[0] ? mapDeliverySummaryRow(reloadedResult.rows[0]) : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async acknowledgeDelivery(input: AcknowledgeDeliveryInput): Promise<DeliveryAcknowledgement | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds);

        const deliveryResult = await client.query<{ id: string; network_id: string; recipient_member_id: string }>(
          `
            select d.id, d.network_id, d.recipient_member_id
            from app.pending_deliveries d
            where d.id = $1
              and d.recipient_member_id = $2
              and d.network_id = any($3::app.short_id[])
          `,
          [input.deliveryId, input.actorMemberId, input.accessibleNetworkIds],
        );

        const delivery = deliveryResult.rows[0];
        if (!delivery) {
          await client.query('rollback');
          return null;
        }

        const currentAckResult = await client.query<{ acknowledgement_id: string; version_no: number }>(
          `
            select id as acknowledgement_id, version_no
            from app.current_delivery_acknowledgements
            where delivery_id = $1
              and recipient_member_id = $2
          `,
          [delivery.id, delivery.recipient_member_id],
        );

        const currentAck = currentAckResult.rows[0];
        const ackResult = await client.query<DeliveryAcknowledgementRow>(
          `
            insert into app.delivery_acknowledgements (
              delivery_id,
              recipient_member_id,
              network_id,
              state,
              suppression_reason,
              version_no,
              supersedes_acknowledgement_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5, $6, $7, $8)
            returning
              id as acknowledgement_id,
              delivery_id,
              network_id,
              recipient_member_id,
              state,
              suppression_reason,
              version_no,
              supersedes_acknowledgement_id,
              created_at::text,
              created_by_member_id
          `,
          [
            delivery.id,
            delivery.recipient_member_id,
            delivery.network_id,
            input.state,
            input.state === 'suppressed' ? input.suppressionReason ?? null : null,
            (currentAck?.version_no ?? 0) + 1,
            currentAck?.acknowledgement_id ?? null,
            input.actorMemberId,
          ],
        );

        await client.query('commit');
        return ackResult.rows[0] ? mapDeliveryAcknowledgementRow(ackResult.rows[0]) : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async claimNextDelivery(input: ClaimDeliveryInput): Promise<ClaimedDelivery | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds, { deliveryWorkerScope: true });

        const claimResult = await client.query<{ delivery_id: string }>(
          `
            with next_delivery as (
              select d.id
              from app.deliveries d
              join app.delivery_endpoints de on de.id = d.endpoint_id
              where d.status = 'pending'
                and d.network_id = any($2::app.short_id[])
                and d.scheduled_at <= now()
                and de.state = 'active'
                and de.disabled_at is null
              order by d.scheduled_at asc, d.created_at asc, d.id asc
              for update of d skip locked
              limit 1
            ), updated as (
              update app.deliveries d
              set status = 'processing',
                  attempt_count = d.attempt_count + 1,
                  last_error = null,
                  failed_at = null
              from next_delivery nd
              where d.id = nd.id
              returning d.id, d.network_id, d.endpoint_id, d.attempt_count
            ), inserted as (
              insert into app.delivery_attempts (
                delivery_id,
                network_id,
                endpoint_id,
                worker_key,
                status,
                attempt_no,
                created_by_member_id
              )
              select
                u.id,
                u.network_id,
                u.endpoint_id,
                $3,
                'processing',
                u.attempt_count,
                $1
              from updated u
              returning delivery_id
            )
            select delivery_id
            from inserted
          `,
          [input.actorMemberId, input.accessibleNetworkIds, input.workerKey ?? null],
        );

        const deliveryId = claimResult.rows[0]?.delivery_id;
        if (!deliveryId) {
          await client.query('commit');
          return null;
        }

        const delivery = await loadDeliverySummary(client, deliveryId);
        const attempt = await loadCurrentDeliveryAttempt(client, deliveryId);
        const endpoint = delivery ? await loadDeliveryEndpoint(client, delivery.endpointId) : null;
        await client.query('commit');

        return delivery && attempt && endpoint ? { delivery, attempt, endpoint } : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async completeDeliveryAttempt(input: CompleteDeliveryAttemptInput): Promise<ClaimedDelivery | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds, { deliveryWorkerScope: true });

        const updateResult = await client.query<{ delivery_id: string }>(
          `
            with current_attempt as (
              select cda.id, cda.delivery_id, cda.endpoint_id
              from app.current_delivery_attempts cda
              join app.deliveries d on d.id = cda.delivery_id
              where cda.delivery_id = $2
                and cda.status = 'processing'
                and d.status = 'processing'
                and d.network_id = any($3::app.short_id[])
              for update of d skip locked
            ), finished_attempt as (
              update app.delivery_attempts da
              set status = 'sent',
                  response_status_code = $4,
                  response_body = $5,
                  error_message = null,
                  finished_at = now()
              from current_attempt ca
              where da.id = ca.id
              returning da.delivery_id, da.endpoint_id
            ), finished_delivery as (
              update app.deliveries d
              set status = 'sent',
                  sent_at = now(),
                  failed_at = null,
                  last_error = null
              from finished_attempt fa
              where d.id = fa.delivery_id
              returning d.id as delivery_id, fa.endpoint_id
            ), endpoint_touch as (
              update app.delivery_endpoints dep
              set last_success_at = now()
              from finished_delivery fd
              where dep.id = fd.endpoint_id
              returning fd.delivery_id
            )
            select delivery_id
            from endpoint_touch
          `,
          [input.actorMemberId, input.deliveryId, input.accessibleNetworkIds, input.responseStatusCode ?? null, input.responseBody ?? null],
        );

        const deliveryId = updateResult.rows[0]?.delivery_id;
        if (!deliveryId) {
          await client.query('rollback');
          return null;
        }

        const delivery = await loadDeliverySummary(client, deliveryId);
        const attempt = await loadCurrentDeliveryAttempt(client, deliveryId);
        const endpoint = delivery ? await loadDeliveryEndpoint(client, delivery.endpointId) : null;
        await client.query('commit');

        return delivery && attempt && endpoint ? { delivery, attempt, endpoint } : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async failDeliveryAttempt(input: FailDeliveryAttemptInput): Promise<ClaimedDelivery | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, input.accessibleNetworkIds, { deliveryWorkerScope: true });

        const updateResult = await client.query<{ delivery_id: string }>(
          `
            with current_attempt as (
              select cda.id, cda.delivery_id, cda.endpoint_id
              from app.current_delivery_attempts cda
              join app.deliveries d on d.id = cda.delivery_id
              where cda.delivery_id = $2
                and cda.status = 'processing'
                and d.status = 'processing'
                and d.network_id = any($3::app.short_id[])
              for update of d skip locked
            ), finished_attempt as (
              update app.delivery_attempts da
              set status = 'failed',
                  response_status_code = $5,
                  response_body = $6,
                  error_message = $4,
                  finished_at = now()
              from current_attempt ca
              where da.id = ca.id
              returning da.delivery_id, da.endpoint_id
            ), finished_delivery as (
              update app.deliveries d
              set status = 'failed',
                  failed_at = now(),
                  last_error = $4
              from finished_attempt fa
              where d.id = fa.delivery_id
              returning d.id as delivery_id, fa.endpoint_id
            ), endpoint_touch as (
              update app.delivery_endpoints dep
              set last_failure_at = now()
              from finished_delivery fd
              where dep.id = fd.endpoint_id
              returning fd.delivery_id
            )
            select delivery_id
            from endpoint_touch
          `,
          [input.actorMemberId, input.deliveryId, input.accessibleNetworkIds, input.errorMessage, input.responseStatusCode ?? null, input.responseBody ?? null],
        );

        const deliveryId = updateResult.rows[0]?.delivery_id;
        if (!deliveryId) {
          await client.query('rollback');
          return null;
        }

        const delivery = await loadDeliverySummary(client, deliveryId);
        const attempt = await loadCurrentDeliveryAttempt(client, deliveryId);
        const endpoint = delivery ? await loadDeliveryEndpoint(client, delivery.endpointId) : null;
        await client.query('commit');

        return delivery && attempt && endpoint ? { delivery, attempt, endpoint } : null;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
