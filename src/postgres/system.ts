import { Pool, type PoolClient } from 'pg';
import type {
  ArchiveNetworkInput,
  AssignNetworkOwnerInput,
  CreateNetworkInput,
  NetworkSummary,
  Repository,
} from '../app.ts';

type DbClient = Pool | PoolClient;

type ApplyActorContext = (
  client: DbClient,
  actorMemberId: string,
  networkIds: string[],
  options?: Record<string, never>,
) => Promise<void>;

type WithActorContext = <T>(
  pool: Pool,
  actorMemberId: string,
  networkIds: string[],
  fn: (client: PoolClient) => Promise<T>,
) => Promise<T>;

type NetworkRow = {
  network_id: string;
  slug: string;
  name: string;
  summary: string | null;
  manifesto_markdown: string | null;
  archived_at: string | null;
  owner_member_id: string;
  owner_public_name: string;
  owner_handle: string | null;
  owner_version_no: number;
  owner_created_at: string;
  owner_created_by_member_id: string | null;
};

function mapNetworkRow(row: NetworkRow): NetworkSummary {
  return {
    networkId: row.network_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    manifestoMarkdown: row.manifesto_markdown,
    archivedAt: row.archived_at,
    owner: {
      memberId: row.owner_member_id,
      publicName: row.owner_public_name,
      handle: row.owner_handle,
    },
    ownerVersion: {
      versionNo: Number(row.owner_version_no),
      createdAt: row.owner_created_at,
      createdByMemberId: row.owner_created_by_member_id,
    },
  };
}

async function listNetworks(client: DbClient, includeArchived: boolean): Promise<NetworkSummary[]> {
  const result = await client.query<NetworkRow>(
    `
      select
        n.id as network_id,
        n.slug,
        n.name,
        n.summary,
        n.manifesto_markdown,
        n.archived_at::text,
        owner.member_id as owner_member_id,
        m.public_name as owner_public_name,
        m.handle as owner_handle,
        owner.version_no as owner_version_no,
        owner.created_at::text as owner_created_at,
        owner.created_by_member_id as owner_created_by_member_id
      from app.networks n
      join app.current_network_owners owner on owner.network_id = n.id
      join app.members m on m.id = owner.owner_member_id
      where ($1::boolean = true or n.archived_at is null)
      order by n.archived_at asc nulls first, n.name asc, n.id asc
    `,
    [includeArchived],
  );

  return result.rows.map(mapNetworkRow);
}

async function readNetworkSummary(client: DbClient, networkId: string): Promise<NetworkSummary | null> {
  const result = await client.query<NetworkRow>(
    `
      select
        n.id as network_id,
        n.slug,
        n.name,
        n.summary,
        n.manifesto_markdown,
        n.archived_at::text,
        owner.member_id as owner_member_id,
        m.public_name as owner_public_name,
        m.handle as owner_handle,
        owner.version_no as owner_version_no,
        owner.created_at::text as owner_created_at,
        owner.created_by_member_id as owner_created_by_member_id
      from app.networks n
      join app.current_network_owners owner on owner.network_id = n.id
      join app.members m on m.id = owner.owner_member_id
      where n.id = $1
      limit 1
    `,
    [networkId],
  );

  return result.rows[0] ? mapNetworkRow(result.rows[0]) : null;
}

export function buildSystemRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<Repository, 'listNetworks' | 'createNetwork' | 'archiveNetwork' | 'assignNetworkOwner'> {
  return {
    async listNetworks({ actorMemberId, includeArchived }) {
      return withActorContext(pool, actorMemberId, [], (client) => listNetworks(client, includeArchived));
    },

    async createNetwork(input: CreateNetworkInput): Promise<NetworkSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);

        const networkResult = await client.query<{ network_id: string }>(
          `
            with owner_member as (
              select m.id
              from app.members m
              where m.id = $4
                and m.state = 'active'
            ), inserted_network as (
              insert into app.networks (
                slug,
                name,
                summary,
                owner_member_id,
                manifesto_markdown
              )
              select $1, $2, $3, om.id, $5
              from owner_member om
              returning id as network_id
            ), owner_version as (
              insert into app.network_owner_versions (
                network_id,
                owner_member_id,
                version_no,
                created_by_member_id
              )
              select network_id, $4, 1, $6
              from inserted_network
            )
            select network_id
            from inserted_network
          `,
          [input.slug, input.name, input.summary ?? null, input.ownerMemberId, input.manifestoMarkdown ?? null, input.actorMemberId],
        );

        const networkId = networkResult.rows[0]?.network_id;
        if (!networkId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readNetworkSummary(scopedClient, networkId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async archiveNetwork(input: ArchiveNetworkInput): Promise<NetworkSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);
        const result = await client.query<{ network_id: string }>(
          `
            update app.networks n
            set archived_at = coalesce(n.archived_at, now())
            where n.id = $1
            returning n.id as network_id
          `,
          [input.networkId],
        );

        const networkId = result.rows[0]?.network_id;
        if (!networkId) {
          await client.query('rollback');
          return null;
        }

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readNetworkSummary(scopedClient, networkId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },

    async assignNetworkOwner(input: AssignNetworkOwnerInput): Promise<NetworkSummary | null> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        await applyActorContext(client, input.actorMemberId, []);

        const currentResult = await client.query<{
          network_id: string;
          current_owner_version_id: string;
          current_version_no: number;
        }>(
          `
            select
              n.id as network_id,
              cno.id as current_owner_version_id,
              cno.version_no as current_version_no
            from app.networks n
            join app.current_network_owners cno on cno.network_id = n.id
            join app.members m on m.id = $2 and m.state = 'active'
            where n.id = $1
            limit 1
          `,
          [input.networkId, input.ownerMemberId],
        );

        const current = currentResult.rows[0];
        if (!current) {
          await client.query('rollback');
          return null;
        }

        await client.query(
          `
            insert into app.network_owner_versions (
              network_id,
              owner_member_id,
              version_no,
              supersedes_owner_version_id,
              created_by_member_id
            )
            values ($1, $2, $3, $4, $5)
          `,
          [input.networkId, input.ownerMemberId, Number(current.current_version_no) + 1, current.current_owner_version_id, input.actorMemberId],
        );

        await client.query('commit');
        return withActorContext(pool, input.actorMemberId, [], (scopedClient) => readNetworkSummary(scopedClient, input.networkId));
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
