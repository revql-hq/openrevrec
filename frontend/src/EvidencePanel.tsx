import { useState } from "react";
import { ArrowDownToLine, FileText, Upload } from "lucide-react";

import type { ViewProps } from "./App";
import type { Evidence } from "./types";
import { api, dateLabel } from "./api";
import { Button, Empty, ErrorMessage, Field, Section } from "./components";

export function EvidencePanel({
  props,
  entityId,
  targetChangeSetId,
  scenarioId,
  linkedEvidence,
  onAttached,
}: {
  props: ViewProps;
  entityId?: string;
  targetChangeSetId?: string;
  scenarioId?: string;
  linkedEvidence?: Evidence[];
  onAttached?: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const evidence = (linkedEvidence || props.state.evidence || []).filter((item) =>
    targetChangeSetId
      ? item.target_change_set_id === targetChangeSetId
      : item.entity_id === entityId,
  );

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    setError("");
    const data = new FormData();
    data.append("file", file);
    if (entityId) data.append("entity_id", entityId);
    if (targetChangeSetId) data.append("target_change_set_id", targetChangeSetId);
    data.append("scenario_id", scenarioId || props.state.scenario_id);
    data.append("period", props.period);
    data.append("rationale", rationale);
    try {
      await api("/api/evidence", { method: "POST", body: data });
      setFile(null);
      setRationale("");
      await props.refresh("Evidence attached.");
      onAttached?.();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="Attach evidence"
        subtitle="Keep signed agreements, analyses, and support with the accounting record."
      >
        <div className="upload-row">
          <label className="file-picker">
            <Upload size={17} />
            <span>{file?.name || "Choose a supporting file"}</span>
            <input
              type="file"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
            />
          </label>
          <Button primary disabled={!file} busy={busy} onClick={upload}>
            Attach
          </Button>
        </div>
        <Field label="Why this file matters">
          <input
            value={rationale}
            onChange={(event) => setRationale(event.target.value)}
            placeholder="Optional evidence note"
          />
        </Field>
        <ErrorMessage error={error} />
      </Section>
      <Section title="Linked evidence">
        {evidence.length ? (
          <div className="evidence-list">
            {evidence.map((item) => (
              <div className="evidence-row" key={item.id}>
                <FileText size={16} />
                <div>
                  <strong>{item.name}</strong>
                  <span>
                    {item.rationale || "Supporting evidence"} ·{" "}
                    {dateLabel(item.recorded_at)}
                  </span>
                </div>
                <a
                  className="button"
                  href={`/api/evidence/${encodeURIComponent(item.id)}?scenario_id=${encodeURIComponent(scenarioId || props.state.scenario_id)}`}
                  download
                >
                  <ArrowDownToLine size={14} />
                  Download
                </a>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No evidence attached">
            {targetChangeSetId
              ? "Attach the source document or analysis supporting this change."
              : "Attach source documents and support used for this contract’s accounting conclusions."}
          </Empty>
        )}
      </Section>
    </>
  );
}
