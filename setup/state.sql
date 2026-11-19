-- fabrik setup: where this project stands, read before setup builds anything. Reads only, as postgres, run by
-- fabrik setup --owner. One row:
--   fabrik_built       the fabrik schema is there;
--   setup_finished  general, reference and administration are all there, each enabled;
--   actors          fabrik's actors;
--   records         fabrik's records;
--   files           files in fabrik's scopes' buckets;
--   runner_ready    the fabrik_setup schema, which the fabrik-setup hosted function reads, is there.
-- A project with fabrik_built false is new. One with fabrik_built true and setup_finished false is an earlier, unfinished
-- attempt: reset.sql takes it off when records and files are both 0.
select
 to_regnamespace('fabrik') is not null as fabrik_built,
 case when to_regclass('fabrik.scope') is null then false
  else (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from fabrik.scope
   where code in ('general', 'reference', 'administration') and enabled$q$, false, true, '')))[1]::text::int = 3 end as setup_finished,
 case when to_regclass('fabrik.actor') is null then 0
  else (xpath('/row/n/text()', query_to_xml('select count(*) as n from fabrik.actor', false, true, '')))[1]::text::int end as actors,
 case when to_regclass('fabrik.record') is null then 0
  else (xpath('/row/n/text()', query_to_xml('select count(*) as n from fabrik.record', false, true, '')))[1]::text::int end as records,
 case when to_regclass('fabrik.scope') is null then 0
  else (xpath('/row/n/text()', query_to_xml('select count(*) as n from storage.objects o join fabrik.scope s on s.code = o.bucket_id',
   false, true, '')))[1]::text::int end as files,
 to_regclass('fabrik_setup.approved') is not null as runner_ready;
