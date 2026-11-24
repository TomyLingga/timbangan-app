-- Phase 5, notifications. The tables user_devices, notifications and notification_deliveries are in 0001; this adds
-- what the sender loop needs to work on them.

-- When a delivery row was made. A reminder adds PUSH rows to an existing notification later than the notification
-- itself, and the sender drops a push that waited too long (a phone must not ring for a request decided long ago).
alter table notification_deliveries add column created_at timestamptz not null default now();

-- One "raised" and one "closed" notification per exception: the loop that makes them from the state of the
-- exceptions may run in more than one process, and the second insert then does nothing. It also serves the lookups
-- of the notifications of an exception.
create unique index notifications_exception_once on notifications (exception_id, type)
    where type in ('EXCEPTION_RAISED', 'EXCEPTION_CLOSED');

-- The pushes still to send, read by the sender every few seconds.
create index notification_deliveries_push_pending_idx on notification_deliveries (id)
    where channel = 'PUSH' and sent_at is null and error is null;

-- The deliveries of one notification (the recipients of a reminder or of a closed request).
create index notification_deliveries_notification_idx on notification_deliveries (notification_id);
