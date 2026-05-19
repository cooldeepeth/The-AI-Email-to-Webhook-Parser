"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import AuthGate, { signOut } from "@/components/AuthGate";
import { api } from "@/lib/api-client";

interface EndpointSummary {
  id: string;
  name: string;
  inbound_email_slug: string;
  target_webhook_url: string;
  is_active: boolean;
  created_at: string;
}

function Dashboard() {
  const router = useRouter();
  const [endpoints, setEndpoints] = useState<EndpointSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [schema, setSchema] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await api<{ endpoints: EndpointSummary[] }>(
        "/api/v1/endpoints",
      );
      setEndpoints(res.endpoints);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load endpoints");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setErr(null);
    try {
      await api("/api/v1/endpoints", {
        method: "POST",
        body: JSON.stringify({
          name,
          target_webhook_url: url,
          ai_prompt_schema: schema,
        }),
      });
      setName("");
      setUrl("");
      setSchema("");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function logout() {
    await signOut();
    router.replace("/login");
  }

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="brand">thook</div>
        <button className="secondary" onClick={logout}>
          Sign out
        </button>
      </div>

      <div className="panel">
        <h2>New endpoint</h2>
        <form onSubmit={create}>
          <label htmlFor="n">Name</label>
          <input
            id="n"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Supplier Invoice Parser"
            required
          />
          <label htmlFor="u">Target webhook URL</label>
          <input
            id="u"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-server.com/hooks/thook"
            required
          />
          <label htmlFor="s">AI prompt / schema</label>
          <textarea
            id="s"
            value={schema}
            onChange={(e) => setSchema(e.target.value)}
            placeholder="Extract total_amount (number), invoice_date (YYYY-MM-DD), vendor_name (string)."
            required
          />
          <div style={{ marginTop: 16 }}>
            <button type="submit" disabled={creating}>
              {creating ? "Creating…" : "Create endpoint"}
            </button>
          </div>
        </form>
      </div>

      <div className="panel">
        <h2>Endpoints</h2>
        {err && <p className="error">{err}</p>}
        {loading ? (
          <p className="muted">Loading…</p>
        ) : endpoints.length === 0 ? (
          <p className="muted">No endpoints yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Inbound address</th>
                <th>Active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {endpoints.map((ep) => (
                <tr key={ep.id}>
                  <td>{ep.name}</td>
                  <td className="mono">{ep.inbound_email_slug}@…</td>
                  <td>{ep.is_active ? "yes" : "no"}</td>
                  <td>
                    <Link href={`/endpoints/${ep.id}`}>Manage →</Link>
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
      <Dashboard />
    </AuthGate>
  );
}
