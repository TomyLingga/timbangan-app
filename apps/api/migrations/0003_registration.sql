-- Phase 3: registration, delivery orders, SPJ and the registration desk.

-- What the checks found when a registration was saved or submitted: [{ code, message, tripSeq?, allocationSeq? }].
-- A registration with findings waits for a logistics admin when settings.registration_review says so.
alter table registrations add column check_findings jsonb not null default '[]';

-- Pattern of a delivery order number made by the application when none is typed. Placeholders:
-- {seq:N} running number per site per year, zero-padded to N digits; {site} site code; {roman} month in
-- roman numerals; {yyyy}, {yy}, {mm} date of the DO. The value is a setting so a company pattern lives in the
-- database, not in the code.
insert into settings (site_id, key, value)
select s.id, 'do_number_format', '"{seq:3}/DO/{site}/{roman}/{yyyy}"'::jsonb
from sites s
on conflict do nothing;
