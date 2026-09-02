ALTER TABLE allocation_history_run
  DROP CONSTRAINT allocation_history_run_succeeded_complete;

ALTER TABLE allocation_history_run
  ADD CONSTRAINT allocation_history_run_succeeded_complete CHECK (
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
      AND coverage_safe_for_timeline IS NOT NULL
      AND coverage_known_gaps IS NOT NULL
      AND (
        (coverage_safe_for_timeline IS TRUE AND coverage_known_gaps = '[]'::jsonb)
        OR (
          coverage_safe_for_timeline IS FALSE
          AND jsonb_array_length(coverage_known_gaps) > 0
        )
      )
      AND vault_payload IS NOT NULL
      AND entry_count > 0
      AND completed_at IS NOT NULL
    )
  );
