CREATE TABLE allocation_history_projection (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_id integer NOT NULL CHECK (chain_id > 0),
  vault_address text NOT NULL CHECK (vault_address = lower(vault_address)),
  vault_label text NOT NULL,
  active_run_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, vault_address)
);

CREATE TABLE allocation_history_run (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  projection_id bigint NOT NULL REFERENCES allocation_history_projection(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('backfill', 'refresh')),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  schema_version smallint NOT NULL DEFAULT 2,
  materializer_version text NOT NULL,
  generated_at bigint,
  safe_block bigint,
  safe_block_timestamp bigint,
  coverage_start_block bigint,
  coverage_start_block_hash text,
  validated_through_block bigint,
  validated_through_block_hash text,
  coverage_revision text,
  coverage_producer_commit text,
  coverage_safe_for_timeline boolean,
  coverage_known_gaps jsonb,
  vault_payload jsonb,
  entry_count integer,
  error_code text,
  error_detail text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT allocation_history_run_projection_id_id_unique UNIQUE (projection_id, id),
  CONSTRAINT allocation_history_run_known_gaps_array CHECK (
    coverage_known_gaps IS NULL OR jsonb_typeof(coverage_known_gaps) = 'array'
  ),
  CONSTRAINT allocation_history_run_succeeded_complete CHECK (
    status <> 'succeeded' OR (
      schema_version = 2
      AND generated_at IS NOT NULL
      AND safe_block IS NOT NULL
      AND safe_block_timestamp IS NOT NULL
      AND coverage_start_block IS NOT NULL
      AND coverage_start_block_hash IS NOT NULL
      AND validated_through_block IS NOT NULL
      AND validated_through_block_hash IS NOT NULL
      AND coverage_revision IS NOT NULL
      AND coverage_producer_commit IS NOT NULL
      AND coverage_safe_for_timeline IS TRUE
      AND coverage_known_gaps = '[]'::jsonb
      AND vault_payload IS NOT NULL
      AND entry_count > 0
      AND completed_at IS NOT NULL
    )
  )
);

ALTER TABLE allocation_history_projection
  ADD CONSTRAINT allocation_history_projection_active_run_fk
  FOREIGN KEY (id, active_run_id) REFERENCES allocation_history_run(projection_id, id);

CREATE UNIQUE INDEX allocation_history_one_running_run
  ON allocation_history_run (projection_id)
  WHERE status = 'running';

CREATE INDEX allocation_history_run_projection_status
  ON allocation_history_run (projection_id, status, id DESC);

CREATE TABLE allocation_history_entry (
  run_id bigint NOT NULL REFERENCES allocation_history_run(id) ON DELETE CASCADE,
  entry_id text NOT NULL,
  kind text NOT NULL,
  start_block bigint NOT NULL,
  end_block bigint NOT NULL,
  start_timestamp bigint NOT NULL,
  end_timestamp bigint NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, entry_id),
  CHECK (start_block <= end_block),
  CHECK (start_timestamp <= end_timestamp)
);

CREATE INDEX allocation_history_entry_desc_page
  ON allocation_history_entry (run_id, end_block DESC, entry_id DESC);

CREATE INDEX allocation_history_entry_asc_page
  ON allocation_history_entry (run_id, end_block ASC, entry_id ASC);
