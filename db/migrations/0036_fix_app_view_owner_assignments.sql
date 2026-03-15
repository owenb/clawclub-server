begin;

alter view app.accessible_network_memberships owner to clawclub_view_owner;
alter view app.active_network_memberships owner to clawclub_view_owner;
alter view app.current_application_versions owner to clawclub_view_owner;
alter view app.current_applications owner to clawclub_view_owner;
alter view app.current_dm_inbox_threads owner to clawclub_view_owner;
alter view app.current_entity_version_embeddings owner to clawclub_view_owner;
alter view app.current_entity_versions owner to clawclub_view_owner;
alter view app.current_event_rsvps owner to clawclub_view_owner;
alter view app.current_member_global_role_versions owner to clawclub_view_owner;
alter view app.current_member_global_roles owner to clawclub_view_owner;
alter view app.current_member_profiles owner to clawclub_view_owner;
alter view app.current_member_update_receipts owner to clawclub_view_owner;
alter view app.current_network_membership_states owner to clawclub_view_owner;
alter view app.current_network_memberships owner to clawclub_view_owner;
alter view app.current_network_owners owner to clawclub_view_owner;
alter view app.current_profile_version_embeddings owner to clawclub_view_owner;
alter view app.current_published_entity_versions owner to clawclub_view_owner;
alter view app.live_entities owner to clawclub_view_owner;
alter view app.live_subscriptions owner to clawclub_view_owner;
alter view app.pending_member_updates owner to clawclub_view_owner;

commit;
