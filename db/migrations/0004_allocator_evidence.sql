-- Keep the assignment and independent deployment inputs with their immutable run.
ALTER TABLE allocation_history_run
  ADD COLUMN allocator_evidence jsonb NOT NULL DEFAULT '{"events":[],"deployments":[]}'::jsonb;
