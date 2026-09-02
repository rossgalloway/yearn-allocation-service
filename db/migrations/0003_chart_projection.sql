ALTER TABLE allocation_history_entry
  ADD COLUMN chart_payload jsonb;

CREATE INDEX allocation_history_entry_chart_page
  ON allocation_history_entry (run_id, end_block, entry_id)
  WHERE kind IN ('idle_deployment', 'idle_deallocation', 'strategy_reallocation');
