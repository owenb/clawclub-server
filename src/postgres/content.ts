import type { Pool } from 'pg';
import type { Repository } from '../app.ts';
import type { ApplyActorContext, WithActorContext } from './shared.ts';
import { buildEntitiesRepository } from './entities.ts';
import { buildEventsRepository } from './events.ts';

export function buildContentRepository({
  pool,
  applyActorContext,
  withActorContext,
}: {
  pool: Pool;
  applyActorContext: ApplyActorContext;
  withActorContext: WithActorContext;
}): Pick<
  Repository,
  'createEntity' | 'updateEntity' | 'archiveEntity' | 'listEntities' | 'createEvent' | 'listEvents' | 'rsvpEvent'
> {
  return {
    ...buildEntitiesRepository({ pool, applyActorContext, withActorContext }),
    ...buildEventsRepository({ pool, applyActorContext, withActorContext }),
  };
}
