"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import AuthGate from "@/components/AuthGate";
import { api } from "@/lib/api-client";

interface LogDetail {
  id: string;
  endpoint_id: string;
  status: string;
  raw_email_payload: unknown;
  parsed_json_output: unknown;
  http_response_code: number | null;
  retry_count: number;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

function LogView() {
  const { id } = useParams<{ id: string }>();
  const [log, setLog] = useState<LogDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<{ log: LogDetail }>(`/api/v1/logs/${id}`)
      .then((r) => setLog(r.log))
      .catch((e) =>
        setErr(e instanceof Error ? e.message : "Failed to load log"),
      );
  }, [id]);

  if (err) {
    return (
      <div className="wrap">
        <p className="error">{err}</p>
        <Link href="/">← Back</Link>
      </div>
    );
  }
  if (!log) {
    return (
      <div className="wrap">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">thook</div>
        <Link href={`/endpoints/${log.endpoint_id}`}>← Endpoint</Link>
      </div>

      <div className="panel">
        <h2>Log {log.id}</h2>
        <p>
          <span className={`badge ${log.status}`}>{log.status}</span>
        </p>
        <table>
          <tbody>
            <tr>
              <th>HTTP response</th>
              <td>{log.http_response_code ?? "—"}</td>
            </tr>
            <tr>
              <th>Retry count</th>
              <td>{log.retry_count}</td>
            </tr>
            <tr>
              <th>Created</th>
              <td>{new Date(log.created_at).toLocaleString()}</td>
            </tr>
            <tr>
              <th>Updated</th>
              <td>{new Date(log.updated_at).toLocaleString()}</td>
            </tr>
            {log.error_message && (
              <tr>
                <th>Error</th>
                <td className="error">{log.error_message}</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="panel">
        <h2>Parsed JSON output</h2>
        <pre>{JSON.stringify(log.parsed_json_output, null, 2)}</pre>
      </div>

      <div className="panel">
        <h2>Raw email payload</h2>
        <pre>{JSON.stringify(log.raw_email_payload, null, 2)}</pre>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <AuthGate>
      <LogView />
    </AuthGate>
  );
}
