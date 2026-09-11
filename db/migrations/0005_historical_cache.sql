-- Only explicit finalized anchors may seed these caches. Public runs stay immutable.
CREATE TABLE allocation_finalized_block (
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  block_timestamp bigint NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);
CREATE TABLE allocation_historical_cache (
  cache_key text PRIMARY KEY,
  chain_id integer NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  namespace text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX allocation_historical_cache_chain_block ON allocation_historical_cache(chain_id, block_number);
