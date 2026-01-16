-- supabase/migrations/20260115_000000_create_print_agents_company_printers_and_reserve_print_job.sql
-- Migration: cria print_agents, company_printers, ajustes em print_jobs e função RPC reserve_print_job

-- 1) Tabela print_agents
CREATE TABLE IF NOT EXISTS public.print_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name text NOT NULL,
  api_key_hash text NOT NULL,           -- hash (bcrypt) do api_key
  api_key_prefix text NOT NULL,         -- prefix para busca rápida do agente
  is_active boolean NOT NULL DEFAULT true,
  last_seen timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS print_agents_company_name_uq ON public.print_agents(company_id, name);

-- 2) company_printers (vínculo empresa ↔ impressora)
CREATE TABLE IF NOT EXISTS public.company_printers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  printer_id uuid NOT NULL REFERENCES public.printers(id) ON DELETE CASCADE,
  config jsonb DEFAULT '{}'::jsonb, -- perfil/alias/prefs
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS company_printers_uq ON public.company_printers (company_id, printer_id);

-- 3) Ajustes em print_jobs
ALTER TABLE IF EXISTS public.print_jobs
  ADD COLUMN IF NOT EXISTS processed_by uuid REFERENCES public.print_agents(id),
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reserved_at timestamptz,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz;

-- índice para busca rápida de jobs pendentes
CREATE INDEX IF NOT EXISTS print_jobs_pending_company_idx ON public.print_jobs (company_id, status, created_at);

-- 4) RPC: reserve_print_job
-- Retorna 0 ou 1 job reservado (coloca status = 'processing' e processed_by = agent)
CREATE OR REPLACE FUNCTION public.reserve_print_job(p_company uuid, p_agent uuid)
RETURNS SETOF public.print_jobs
LANGUAGE plpgsql
AS $$
DECLARE
  v_job public.print_jobs%ROWTYPE;
BEGIN
  FOR v_job IN
    SELECT * FROM public.print_jobs
    WHERE company_id = p_company
      AND status = 'pending'
    ORDER BY created_at
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.print_jobs
    SET status = 'processing',
        processed_by = p_agent,
        reserved_at = now(),
        attempts = COALESCE(attempts, 0) + 1
    WHERE id = v_job.id;

    RETURN QUERY
      SELECT * FROM public.print_jobs WHERE id = v_job.id;
    RETURN;
  END LOOP;

  RETURN;
END;
$$ SECURITY DEFINER;

-- Grant execute to authenticated role if you want agents to call RPC directly
-- but recommended: backend (service role) calls this RPC. Uncomment if needed:
-- GRANT EXECUTE ON FUNCTION public.reserve_print_job(uuid, uuid) TO authenticated;

