"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import AuthGate from "@/components/AuthGate";
import { api } from "@/lib/api-client";

interface Endpoint {
  id: string;
  name: string;
  inbound_email_slug: string;
  target_webhook_url: string;
  ai_prompt_schema: string;
  is_active: boolean;
  webhook_secret: string;
}

interface LogRow {
  id: string;
  status: string;
  http_response_code: number | null;
  retry_count: number;
  created_at: string;
}

const STATUSES = [
  "",
  "received",
  "processing",
  "success",
  "failed_ai",
  "failed_delivery",
  "quota_exceeded",
];

function Detail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [ep, setEp] = useState<Endpoint | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadEndpoint = useCallback(async () => {
    const res = await api<{ endpoint: Endpoint }>(`/api/v1/endpoints/${id}`);
    setEp(res.endpoint);
  }, [id]);

  const loadLogs = useCallback(async () => {
    const qs = statusFilter ? `?status=${statusFilter}` : "";
    const res = await api<{ logs: LogRow[] }>(
      `/api/v1/endpoints/${id}/logs${qs}`,
    );
    setLogs(res.logs);
  }, [id, statusFilter]);

  useEffect(() => {
    loadEndpoint().catch((e) =>
      setErr(e instanceof Error ? e.message : "load failed"),
    );
  }, [loadEndpoint]);

  useEffect(() => {
    loadLogs().catch((e) =>
      setErr(e instanceof Error ? e.message : "log load failed"),
    );
  }, [loadLogs]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!ep) return;
    setSaving(true);
    setErr(null);
    setNotice(null);
    try {
      await api(`/api/v1/endpoints/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: ep.name,
          target_webhook_url: ep.target_webhook_url,
          ai_prompt_schema: ep.ai_prompt_schema,
          is_active: ep.is_active,
        }),
      });
      setNotice("Saved.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "save failed");
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    setErr(null);
    setNotice(null);
    try {
      const res = await api<{ webhook_secret: string }>(
        `/api/v1/endpoints/${id}/rotate-secret`,
        { method: "POST" },
      );
      setEp((p) => (p ? { ...p, webhook_secret: res.webhook_secret } : p));
      setNotice("Secret rotated. Update your receiver with the new value.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "rotate failed");
    }
  }

  async function remove() {
    if (!confirm("Delete this endpoint and all its logs?")) return;
    try {
      await api(`/api/v1/endpoints/${id}`, { method: "DELETE" });
      router.replace("/");
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete failed");
    }
  }

  if (!ep) {
    return (
      <div className="wrap">
        {err ? <p className="error">{err}</p> : <p className="muted">Loading…</p>}
        <Link href="/">← Back</Link>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">thook</div>
        <Link href="/">← All endpoints</Link>
      </div>

      {err && <p className="error">{err}</p>}
      {notice && <p className="ok">{notice}</p>}

      <div className="panel">
        <h2>Configuration</h2>
        <form onSubmit={save}>
          <label>Name</label>
          <input
            value={ep.name}
            onChange={(e) => setEp({ ...ep, name: e.target.value })}
          />
          <label>Target webhook URL</label>
          <input
            value={ep.target_webhook_url}
            onChange={(e) =>
              setEp({ ...ep, target_webhook_url: e.target.value })
            }
          />
          <label>AI prompt / schema</label>
          <textarea
            value={ep.ai_prompt_schema}
            onChange={(e) =>
              setEp({ ...ep, ai_prompt_schema: e.target.value })
            }
          />
          <label>
            <input
              type="checkbox"
              checked={ep.is_active}
              onChange={(e) =>
                setEp({ ...ep, is_active: e.target.checked })
              }
              style={{ width: "auto", marginRight: 8 }}
            />
            Active
          </label>
          <div className="row" style={{ marginTop: 16 }}>
            <button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save changes"}
            </button>
            <button type="button" className="danger" onClick={remove}>
              Delete
            </button>
          </div>
        </form>
      </div>

      <div className="panel">
        <h2>Inbound &amp; signing</h2>
        <p className="muted">Inbound address</p>
        <p className="mono">{ep.inbound_email_slug}@inbound.thook.io</p>
        <p className="muted" style={{ marginTop: 14 }}>
          Webhook secret
        </p>
        <p className="mono">{ep.webhook_secret}</p>
        <button
          className="secondary"
          style={{ marginTop: 12 }}
          onClick={rotate}
        >
          Rotate secret
        </button>
      </div>

      <div className="panel">
        <h2>Logs</h2>
        <div className="row" style={{ marginBottom: 14 }}>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ width: "auto" }}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === "" ? "all statuses" : s}
              </option>
            ))}
          </select>
        </div>
        {logs.length === 0 ? (
          <p className="muted">No logs.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Status</th>
                <th>HTTP</th>
                <th>Retries</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="muted">
                    {new Date(l.created_at).toLocaleString()}
                  </td>
                  <td>
                    <span className={`badge ${l.status}`}>{l.status}</span>
                  </td>
                  <td>{l.http_response_code ?? "—"}</td>
                  <td>{l.retry_count}</td>
                  <td>
                    <Link href={`/logs/${l.id}`}>View →</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <Detail />
    </AuthGate>
  );
}
