/**
 * The catalog reads a compatibility comparison is built from: which schemas
 * count as the user's, and every catalog object a migration can leave behind,
 * each as canonical rows that hash the same when the objects are the same.
 */
export const USER_SCHEMAS = `
  SELECT * FROM pg_catalog.pg_namespace
  WHERE left(nspname, 3) <> 'pg_'
    AND nspname NOT IN ('information_schema', 'dads_migration')
`;

export const CATALOG_STATE = `
WITH user_schemas AS (${USER_SCHEMAS}),
relations AS (
  SELECT c.*, n.nspname
  FROM pg_catalog.pg_class c JOIN user_schemas n ON n.oid = c.relnamespace
), objects AS (
  SELECT jsonb_build_object(
    'kind', 'schema', 'name', nspname, 'owner', pg_get_userbyid(nspowner),
    'acl', (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(nspacl) a)
  ) AS definition FROM user_schemas
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'relation', 'schema', c.nspname, 'name', c.relname,
    'relationKind', c.relkind, 'persistence', c.relpersistence,
    'owner', pg_get_userbyid(c.relowner), 'replicaIdentity', c.relreplident,
    'rowSecurity', c.relrowsecurity, 'forceRowSecurity', c.relforcerowsecurity,
    'accessMethod', am.amname,
    'options', (SELECT jsonb_agg(o ORDER BY o) FROM unnest(c.reloptions) o),
    'acl', (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(c.relacl) a),
    'partitionKey', CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
    'partitionBound', pg_get_expr(c.relpartbound, c.oid, false),
    'view', CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, false) END,
    'populated', CASE WHEN c.relkind = 'm' THEN c.relispopulated END,
    'comment', obj_description(c.oid, 'pg_class')
  ) FROM relations c LEFT JOIN pg_catalog.pg_am am ON am.oid = c.relam
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'column', 'schema', c.nspname, 'relation', c.relname,
    'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
    'nullable', NOT a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid, false),
    'identity', a.attidentity, 'generated', a.attgenerated,
    'storage', a.attstorage, 'compression', a.attcompression,
    'collation', CASE WHEN co.oid IS NOT NULL THEN jsonb_build_array(cn.nspname, co.collname) END,
    -- PostgreSQL 16.16 stamps each column with a per-database pg_attver
    -- counter, so two identical schemas never match on it; it is not schema.
    'options', (SELECT jsonb_agg(o ORDER BY o) FROM unnest(a.attoptions) o
      WHERE o NOT LIKE 'pg\\_attver=%'),
    'foreignOptions', (SELECT jsonb_agg(o ORDER BY o) FROM unnest(a.attfdwoptions) o),
    'acl', (SELECT jsonb_agg(p::text ORDER BY p::text) FROM unnest(a.attacl) p),
    'compositePosition', CASE WHEN c.relkind = 'c' THEN a.attnum END,
    'comment', col_description(c.oid, a.attnum)
  ) FROM relations c
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
  LEFT JOIN pg_catalog.pg_collation co ON co.oid = a.attcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = co.collnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'constraint', 'schema', n.nspname, 'name', co.conname,
    'relation', r.relname, 'domain', t.typname,
    'definition', pg_get_constraintdef(co.oid, false),
    'validated', co.convalidated, 'local', co.conislocal,
    'noInherit', co.connoinherit, 'comment', obj_description(co.oid, 'pg_constraint')
  ) FROM pg_catalog.pg_constraint co
  JOIN user_schemas n ON n.oid = co.connamespace
  LEFT JOIN pg_catalog.pg_class r ON r.oid = co.conrelid
  LEFT JOIN pg_catalog.pg_type t ON t.oid = co.contypid
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'index', 'schema', c.nspname, 'table', c.relname,
    'definition', pg_get_indexdef(i.indexrelid, 0, false),
    'valid', i.indisvalid, 'ready', i.indisready, 'live', i.indislive,
    'clustered', i.indisclustered, 'replicaIdentity', i.indisreplident
  ) FROM pg_catalog.pg_index i JOIN relations c ON c.oid = i.indrelid
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'inheritance', 'schema', c.nspname, 'relation', c.relname,
    'parent', jsonb_build_array(pn.nspname, p.relname), 'position', i.inhseqno
  ) FROM pg_catalog.pg_inherits i
  JOIN relations c ON c.oid = i.inhrelid
  JOIN pg_catalog.pg_class p ON p.oid = i.inhparent
  JOIN pg_catalog.pg_namespace pn ON pn.oid = p.relnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'trigger', 'schema', c.nspname, 'relation', c.relname,
    'name', CASE WHEN NOT t.tgisinternal THEN t.tgname END,
    'definition', CASE WHEN t.tgisinternal
      THEN replace(pg_get_triggerdef(t.oid, false), quote_ident(t.tgname), '<internal-trigger>')
      ELSE pg_get_triggerdef(t.oid, false) END,
    'function', t.tgfoid::regprocedure::text, 'type', t.tgtype,
    'enabled', t.tgenabled, 'internal', t.tgisinternal,
    'constraint', co.conname, 'constraintRelation', cr.relname,
    'constraintSchema', crn.nspname, 'deferrable', t.tgdeferrable,
    'initiallyDeferred', t.tginitdeferred,
    'arguments', encode(t.tgargs, 'hex'),
    'columns', (SELECT jsonb_agg(a.attname ORDER BY a.attname)
      FROM unnest(t.tgattr::smallint[]) trigger_column(attnum)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = trigger_column.attnum),
    'comment', obj_description(t.oid, 'pg_trigger')
  ) FROM pg_catalog.pg_trigger t JOIN relations c ON c.oid = t.tgrelid
  LEFT JOIN pg_catalog.pg_constraint co ON co.oid = t.tgconstraint
  LEFT JOIN pg_catalog.pg_class cr ON cr.oid = t.tgconstrrelid
  LEFT JOIN pg_catalog.pg_namespace crn ON crn.oid = cr.relnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'eventTrigger', 'schema', n.nspname, 'name', e.evtname,
    'event', e.evtevent, 'enabled', e.evtenabled,
    'function', e.evtfoid::regprocedure::text, 'owner', pg_get_userbyid(e.evtowner),
    'tags', (SELECT jsonb_agg(tag ORDER BY tag) FROM unnest(e.evttags) tag)
  ) FROM pg_catalog.pg_event_trigger e JOIN pg_catalog.pg_proc p ON p.oid = e.evtfoid
  JOIN user_schemas n ON n.oid = p.pronamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'policy', 'schema', c.nspname, 'relation', c.relname,
    'name', p.polname, 'command', p.polcmd, 'permissive', p.polpermissive,
    'roles', (SELECT jsonb_agg(role_name ORDER BY role_name) FROM (
      SELECT CASE WHEN role_id = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_id)::text END role_name
      FROM unnest(p.polroles) role_id
    ) roles),
    'using', pg_get_expr(p.polqual, p.polrelid, false),
    'check', pg_get_expr(p.polwithcheck, p.polrelid, false)
  ) FROM pg_catalog.pg_policy p JOIN relations c ON c.oid = p.polrelid
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'rule', 'schema', c.nspname, 'relation', c.relname,
    'name', r.rulename, 'enabled', r.ev_enabled, 'definition', pg_get_ruledef(r.oid, false)
  ) FROM pg_catalog.pg_rewrite r JOIN relations c ON c.oid = r.ev_class
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'routine', 'schema', n.nspname, 'name', p.proname,
    'arguments', pg_get_function_identity_arguments(p.oid), 'routineKind', p.prokind,
    'definition', CASE WHEN p.prokind <> 'a' THEN pg_get_functiondef(p.oid) END,
    'allArguments', pg_get_function_arguments(p.oid), 'returns', pg_get_function_result(p.oid),
    'language', l.lanname, 'volatile', p.provolatile, 'parallel', p.proparallel,
    'strict', p.proisstrict, 'securityDefiner', p.prosecdef, 'leakProof', p.proleakproof,
    'cost', p.procost, 'rows', p.prorows, 'returnsSet', p.proretset, 'configuration', p.proconfig,
    'owner', pg_get_userbyid(p.proowner),
    'acl', (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(p.proacl) a),
    'aggregate', CASE WHEN a.aggfnoid IS NOT NULL THEN jsonb_build_object(
      'kind', a.aggkind, 'directArgs', a.aggnumdirectargs,
      'transition', a.aggtransfn::regprocedure::text, 'final', a.aggfinalfn::regprocedure::text,
      'combine', a.aggcombinefn::regprocedure::text, 'serialize', a.aggserialfn::regprocedure::text,
      'deserialize', a.aggdeserialfn::regprocedure::text,
      'movingTransition', a.aggmtransfn::regprocedure::text,
      'movingInverse', a.aggminvtransfn::regprocedure::text,
      'movingFinal', a.aggmfinalfn::regprocedure::text,
      'finalExtra', a.aggfinalextra, 'movingFinalExtra', a.aggmfinalextra,
      'finalModify', a.aggfinalmodify, 'movingFinalModify', a.aggmfinalmodify,
      'sortOperator', a.aggsortop::regoperator::text,
      'transitionType', format_type(a.aggtranstype, NULL), 'transitionSpace', a.aggtransspace,
      'movingType', format_type(a.aggmtranstype, NULL), 'movingSpace', a.aggmtransspace,
      'initialValue', a.agginitval, 'movingInitialValue', a.aggminitval
    ) END, 'comment', obj_description(p.oid, 'pg_proc')
  ) FROM pg_catalog.pg_proc p JOIN user_schemas n ON n.oid = p.pronamespace
  JOIN pg_catalog.pg_language l ON l.oid = p.prolang
  LEFT JOIN pg_catalog.pg_aggregate a ON a.aggfnoid = p.oid
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'type', 'schema', n.nspname, 'name', t.typname, 'typeKind', t.typtype,
    'category', t.typcategory, 'owner', pg_get_userbyid(t.typowner),
    'defined', t.typisdefined, 'preferred', t.typispreferred, 'delimiter', t.typdelim,
    'base', format_type(t.typbasetype, t.typtypmod), 'notNull', t.typnotnull,
    'default', COALESCE(pg_get_expr(t.typdefaultbin, 0, false), t.typdefault),
    'element', format_type(t.typelem, NULL), 'dimensions', t.typndims,
    'collation', (SELECT jsonb_build_array(cn.nspname, c.collname)
      FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace cn ON cn.oid = c.collnamespace
      WHERE c.oid = t.typcollation),
    'length', t.typlen, 'byValue', t.typbyval, 'alignment', t.typalign, 'storage', t.typstorage,
    'input', t.typinput::regprocedure::text, 'output', t.typoutput::regprocedure::text,
    'receive', t.typreceive::regprocedure::text, 'send', t.typsend::regprocedure::text,
    'modifierInput', t.typmodin::regprocedure::text, 'modifierOutput', t.typmodout::regprocedure::text,
    'analyze', t.typanalyze::regprocedure::text,
    'labels', (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder)
      FROM pg_catalog.pg_enum e WHERE e.enumtypid = t.oid),
    'acl', (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(t.typacl) a),
    'comment', obj_description(t.oid, 'pg_type')
  ) FROM pg_catalog.pg_type t JOIN user_schemas n ON n.oid = t.typnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'range', 'schema', n.nspname, 'name', t.typname,
    'subtype', format_type(r.rngsubtype, NULL),
    'collation', jsonb_build_array(cn.nspname, c.collname),
    'multirange', format_type(r.rngmultitypid, NULL),
    'operatorClass', jsonb_build_array(onsp.nspname, oc.opcname),
    'canonical', r.rngcanonical::regprocedure::text, 'difference', r.rngsubdiff::regprocedure::text
  ) FROM pg_catalog.pg_range r
  JOIN pg_catalog.pg_type t ON t.oid = r.rngtypid JOIN user_schemas n ON n.oid = t.typnamespace
  LEFT JOIN pg_catalog.pg_collation c ON c.oid = r.rngcollation
  LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid = c.collnamespace
  JOIN pg_catalog.pg_opclass oc ON oc.oid = r.rngsubopc
  JOIN pg_catalog.pg_namespace onsp ON onsp.oid = oc.opcnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'collation', 'schema', n.nspname, 'name', c.collname,
    'owner', pg_get_userbyid(c.collowner),
    'properties', to_jsonb(c) - 'oid' - 'collnamespace' - 'collowner'
  ) FROM pg_catalog.pg_collation c JOIN user_schemas n ON n.oid = c.collnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'operator', 'schema', n.nspname, 'name', o.oprname,
    'owner', pg_get_userbyid(o.oprowner), 'operatorKind', o.oprkind,
    'left', format_type(o.oprleft, NULL), 'right', format_type(o.oprright, NULL),
    'result', format_type(o.oprresult, NULL), 'function', o.oprcode::regprocedure::text,
    'commutator', o.oprcom::regoperator::text, 'negator', o.oprnegate::regoperator::text,
    'restrict', o.oprrest::regprocedure::text, 'join', o.oprjoin::regprocedure::text,
    'merge', o.oprcanmerge, 'hash', o.oprcanhash
  ) FROM pg_catalog.pg_operator o JOIN user_schemas n ON n.oid = o.oprnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'operatorClass', 'schema', n.nspname, 'name', o.opcname,
    'owner', pg_get_userbyid(o.opcowner), 'accessMethod', a.amname,
    'family', jsonb_build_array(fn.nspname, f.opfname),
    'input', format_type(o.opcintype, NULL), 'key', format_type(o.opckeytype, NULL),
    'default', o.opcdefault
  ) FROM pg_catalog.pg_opclass o JOIN user_schemas n ON n.oid = o.opcnamespace
  JOIN pg_catalog.pg_am a ON a.oid = o.opcmethod
  JOIN pg_catalog.pg_opfamily f ON f.oid = o.opcfamily
  JOIN pg_catalog.pg_namespace fn ON fn.oid = f.opfnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'operatorFamily', 'schema', n.nspname, 'name', f.opfname,
    'owner', pg_get_userbyid(f.opfowner), 'accessMethod', a.amname,
    'operators', (SELECT jsonb_agg(jsonb_build_object(
      'left', format_type(o.amoplefttype, NULL), 'right', format_type(o.amoprighttype, NULL),
      'strategy', o.amopstrategy, 'purpose', o.amoppurpose,
      'operator', o.amopopr::regoperator::text,
      'sortFamily', (SELECT jsonb_build_array(sn.nspname, sf.opfname)
        FROM pg_catalog.pg_opfamily sf JOIN pg_catalog.pg_namespace sn ON sn.oid = sf.opfnamespace
        WHERE sf.oid = o.amopsortfamily)
    ) ORDER BY o.amoplefttype::regtype::text, o.amoprighttype::regtype::text, o.amopstrategy, o.amoppurpose)
      FROM pg_catalog.pg_amop o WHERE o.amopfamily = f.oid),
    'functions', (SELECT jsonb_agg(jsonb_build_object(
      'left', format_type(p.amproclefttype, NULL), 'right', format_type(p.amprocrighttype, NULL),
      'number', p.amprocnum, 'function', p.amproc::regprocedure::text
    ) ORDER BY p.amproclefttype::regtype::text, p.amprocrighttype::regtype::text, p.amprocnum)
      FROM pg_catalog.pg_amproc p WHERE p.amprocfamily = f.oid)
  ) FROM pg_catalog.pg_opfamily f JOIN user_schemas n ON n.oid = f.opfnamespace
  JOIN pg_catalog.pg_am a ON a.oid = f.opfmethod
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'sequence', 'schema', c.nspname, 'name', c.relname,
    'type', format_type(s.seqtypid, NULL), 'start', s.seqstart::text,
    'increment', s.seqincrement::text, 'minimum', s.seqmin::text,
    'maximum', s.seqmax::text, 'cache', s.seqcache::text, 'cycle', s.seqcycle,
    'ownedBy', (SELECT jsonb_agg(jsonb_build_array(n.nspname, r.relname, a.attname))
      FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_class r ON r.oid = d.refobjid
      JOIN pg_catalog.pg_namespace n ON n.oid = r.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
        AND d.refclassid = 'pg_catalog.pg_class'::regclass AND d.deptype IN ('a', 'i'))
  ) FROM pg_catalog.pg_sequence s JOIN relations c ON c.oid = s.seqrelid
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'defaultPrivileges', 'schema', n.nspname, 'role', pg_get_userbyid(d.defaclrole),
    'objectType', d.defaclobjtype,
    'acl', (SELECT jsonb_agg(a::text ORDER BY a::text) FROM unnest(d.defaclacl) a)
  ) FROM pg_catalog.pg_default_acl d LEFT JOIN user_schemas n ON n.oid = d.defaclnamespace
  WHERE d.defaclnamespace = 0 OR n.oid IS NOT NULL
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'extension', 'schema', n.nspname, 'name', e.extname, 'version', e.extversion,
    'owner', pg_get_userbyid(e.extowner), 'relocatable', e.extrelocatable,
    'configuration', (SELECT jsonb_agg(jsonb_build_object(
      'relation', jsonb_build_array(rn.nspname, r.relname), 'condition', e.extcondition[position]
    ) ORDER BY rn.nspname, r.relname)
      FROM unnest(e.extconfig) WITH ORDINALITY entry(relation_id, position)
      JOIN pg_catalog.pg_class r ON r.oid = entry.relation_id
      JOIN pg_catalog.pg_namespace rn ON rn.oid = r.relnamespace)
  ) FROM pg_catalog.pg_extension e JOIN user_schemas n ON n.oid = e.extnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'foreignTable', 'schema', c.nspname, 'name', c.relname,
    'options', (SELECT jsonb_agg(o ORDER BY o) FROM unnest(f.ftoptions) o),
    'server', s.srvname, 'serverType', s.srvtype, 'serverVersion', s.srvversion,
    'serverOptions', (SELECT jsonb_agg(o ORDER BY o) FROM unnest(s.srvoptions) o),
    'wrapper', w.fdwname, 'handler', w.fdwhandler::regprocedure::text,
    'validator', w.fdwvalidator::regprocedure::text,
    'wrapperOptions', (SELECT jsonb_agg(o ORDER BY o) FROM unnest(w.fdwoptions) o)
  ) FROM pg_catalog.pg_foreign_table f JOIN relations c ON c.oid = f.ftrelid
  JOIN pg_catalog.pg_foreign_server s ON s.oid = f.ftserver
  JOIN pg_catalog.pg_foreign_data_wrapper w ON w.oid = s.srvfdw
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'publication', 'owner', pg_get_userbyid(p.pubowner),
    'properties', to_jsonb(p) - 'oid' - 'pubowner'
  ) FROM pg_catalog.pg_publication p
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'publicationTable', 'publication', p.pubname,
    'relation', jsonb_build_array(n.nspname, c.relname),
    'filter', pg_get_expr(r.prqual, r.prrelid, false),
    'columns', (SELECT jsonb_agg(a.attname ORDER BY a.attname COLLATE "C")
      FROM unnest(r.prattrs::smallint[]) published_column(attnum)
      JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum = published_column.attnum)
  ) FROM pg_catalog.pg_publication_rel r
  JOIN pg_catalog.pg_publication p ON p.oid = r.prpubid
  JOIN pg_catalog.pg_class c ON c.oid = r.prrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  UNION ALL
  SELECT jsonb_build_object(
    'kind', 'publicationSchema', 'publication', p.pubname, 'schema', n.nspname
  ) FROM pg_catalog.pg_publication_namespace r
  JOIN pg_catalog.pg_publication p ON p.oid = r.pnpubid
  JOIN pg_catalog.pg_namespace n ON n.oid = r.pnnspid
)
SELECT definition::text AS canonical FROM objects
ORDER BY definition::text COLLATE "C"
`;
