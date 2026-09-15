-- Keep older immutable runs intact. New runs describe event coverage and RPC accounting separately.
ALTER TABLE allocation_history_run ADD COLUMN data_quality jsonb;
ALTER TABLE allocation_history_run DROP CONSTRAINT allocation_history_run_succeeded_complete;
ALTER TABLE allocation_history_run ADD CONSTRAINT allocation_history_run_succeeded_complete CHECK (
  status <> 'succeeded' OR (
    schema_version = 2
    AND generated_at IS NOT NULL
    AND safe_block IS NOT NULL
    AND safe_block_timestamp IS NOT NULL
    AND coverage_start_block IS NOT NULL
    AND validated_through_block IS NOT NULL
    AND coverage_safe_for_timeline IS NOT NULL
    AND coverage_known_gaps IS NOT NULL
    AND vault_payload IS NOT NULL
    AND entry_count > 0
    AND completed_at IS NOT NULL
    AND (
      materializer_version <> 'allocation-history-v2-event-reader'
      OR (data_quality IS NOT NULL AND jsonb_typeof(data_quality) = 'object'
          AND data_quality->>'processingVersion' = materializer_version)
    )
  )
);
