-- The destinations master is no longer used: since 0008 a delivery order carries its destination as typed text,
-- and the web has no page for the master. The module is switched off, so it leaves the permission grid and the
-- permissions an account is shown, and its routes refuse every account. The destinations table and the grants
-- already given stay as they are.
update modules set is_active = false where code = 'destinations';
