-- Phase 6: the control room (docs/fase-6-rancangan.md). The plant map reads zones, flow steps, trip steps and
-- exceptions as they are; it needs no new table. The module that opens it can now be granted.
update modules set is_active = true where code = 'dashboard';
