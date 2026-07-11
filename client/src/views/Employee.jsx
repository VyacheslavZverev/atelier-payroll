import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, photoUrl } from '../api.js';
import { fmt, fmtDate, fileToDataUrl } from '../util.js';
import CameraCapture from './CameraCapture.jsx';

const cameraSupported =
  typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

export default function Employee({ weekId, employeeId, visionReady, onBack, onSummary, onError }) {
  const [data, setData] = useState(null); // { week, employee, invoices, adjustments, ... }
  const [scanProgress, setScanProgress] = useState(null); // { current, total }
  const [scanNotice, setScanNotice] = useState('');
  const [photoView, setPhotoView] = useState(null); // photo_ref shown full-screen
  const [showCustomForm, setShowCustomForm] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  // Invoices added by the most recent scan session — floated to the top and
  // highlighted so the operator can check the fresh batch against the paper.
  const [freshIds, setFreshIds] = useState(() => new Set());
  const [cameraOpen, setCameraOpen] = useState(false);
  const cameraInputRef = useRef(null);
  const galleryInputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/weeks/${weekId}/employee/${employeeId}`));
    } catch (e) {
      onError(e);
    }
  }, [weekId, employeeId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  // Switching employee/week clears the "just added" highlight so it never
  // marks another person's rows.
  useEffect(() => {
    setFreshIds(new Set());
  }, [weekId, employeeId]);

  // ---------------- photo capture ----------------

  async function handleFiles(fileList) {
    const files = [...fileList];
    if (files.length === 0) return;
    setScanNotice('');
    // Start of a new scan session — drop the previous batch's highlight and
    // collect the ids added across this session (one or several photos).
    const added = new Set();
    setFreshIds(new Set());
    const errors = [];
    for (let i = 0; i < files.length; i++) {
      setScanProgress({ current: i + 1, total: files.length });
      try {
        const image = await fileToDataUrl(files[i]);
        const res = await api('/api/scan', {
          method: 'POST',
          body: { week_id: weekId, employee_id: employeeId, image }
        });
        if (!res.ok && res.error) errors.push(res.error);
        for (const inv of res.invoices) added.add(inv.id);
        setData((d) => (d ? { ...d, invoices: [...d.invoices, ...res.invoices] } : d));
        setFreshIds(new Set(added));
      } catch (e) {
        errors.push(e.message);
      }
    }
    setScanProgress(null);
    if (errors.length > 0) setScanNotice([...new Set(errors)].join(' · '));
  }

  // ---------------- invoice edits ----------------

  function localUpdateInvoice(updated) {
    setData((d) =>
      d ? { ...d, invoices: d.invoices.map((i) => (i.id === updated.id ? updated : i)) } : d
    );
  }

  async function patchInvoice(id, patch) {
    try {
      const updated = await api(`/api/invoices/${id}`, { method: 'PATCH', body: patch });
      localUpdateInvoice(updated);
    } catch (e) {
      onError(e);
    }
  }

  async function deleteInvoice(id) {
    if (!confirm('Удалить строку?')) return;
    try {
      await api(`/api/invoices/${id}`, { method: 'DELETE' });
      setData((d) => (d ? { ...d, invoices: d.invoices.filter((i) => i.id !== id) } : d));
    } catch (e) {
      onError(e);
    }
  }

  // ---------------- bulk selection / delete ----------------

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function deleteSelected() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!confirm(`Удалить выбранные накладные (${ids.length})? Это действие нельзя отменить.`)) return;
    try {
      await api('/api/invoices/bulk-delete', { method: 'POST', body: { ids } });
      setData((d) => (d ? { ...d, invoices: d.invoices.filter((i) => !selectedIds.has(i.id)) } : d));
      exitSelectMode();
    } catch (e) {
      onError(e);
    }
  }

  async function addManualRow() {
    try {
      const row = await api('/api/invoices', {
        method: 'POST',
        body: { week_id: weekId, employee_id: employeeId, number: null, amount: 0, paid: true }
      });
      setData((d) => (d ? { ...d, invoices: [...d.invoices, row] } : d));
    } catch (e) {
      onError(e);
    }
  }

  // ---------------- adjustments ----------------

  function localUpdateAdjustment(updated) {
    setData((d) =>
      d ? { ...d, adjustments: d.adjustments.map((a) => (a.id === updated.id ? updated : a)) } : d
    );
  }

  async function patchAdjustment(id, patch) {
    try {
      const updated = await api(`/api/adjustments/${id}`, { method: 'PATCH', body: patch });
      localUpdateAdjustment(updated);
    } catch (e) {
      onError(e);
    }
  }

  async function addCustomAdjustment(label, sign, amount) {
    try {
      const row = await api('/api/adjustments', {
        method: 'POST',
        body: { week_id: weekId, employee_id: employeeId, label, sign, amount }
      });
      setData((d) => (d ? { ...d, adjustments: [...d.adjustments, row] } : d));
      setShowCustomForm(false);
    } catch (e) {
      onError(e);
    }
  }

  async function deleteAdjustment(id) {
    try {
      await api(`/api/adjustments/${id}`, { method: 'DELETE' });
      setData((d) => (d ? { ...d, adjustments: d.adjustments.filter((a) => a.id !== id) } : d));
    } catch (e) {
      onError(e);
    }
  }

  if (!data) {
    return (
      <div className="screen">
        <p className="muted center">Загрузка…</p>
      </div>
    );
  }

  const { week, employee, invoices, adjustments } = data;
  const sum = invoices.reduce((acc, i) => acc + (i.paid ? i.amount : 0), 0);
  const half = Math.round(sum / 2);
  const deductions = adjustments.filter((a) => a.sign === '-').reduce((acc, a) => acc + a.amount, 0);
  const bonuses = adjustments.filter((a) => a.sign === '+').reduce((acc, a) => acc + a.amount, 0);
  const payout = half - deductions + bonuses;
  const standing = adjustments.filter((a) => a.type === 'standing');
  const custom = adjustments.filter((a) => a.type === 'custom');

  // Display order: by invoice number ascending, regardless of how rows were
  // added. Rows without a number yet (just added / unrecognized) go last so
  // they do not disrupt the numbered list. Re-sorts only after a number is
  // committed (on blur), never mid-typing.
  const sortedInvoices = [...invoices].sort((a, b) => {
    if (a.number == null && b.number == null) return a.id - b.id;
    if (a.number == null) return 1;
    if (b.number == null) return -1;
    return a.number - b.number;
  });

  // The just-scanned batch floats to the top (in scan order) so the operator
  // can check it against the paper without hunting through the sorted list.
  // Select mode is about bulk deletion, not review — keep the plain order there.
  const freshRows = selectMode ? [] : sortedInvoices.filter((i) => freshIds.has(i.id));
  freshRows.sort((a, b) => a.id - b.id);
  const restRows = sortedInvoices.filter((i) => freshRows.length === 0 || !freshIds.has(i.id));

  // Build the render list. Fresh rows are grouped by their source photo, each
  // group shown under one thumbnail of that photo (a single sheet holds several
  // invoices, so a per-row thumbnail would just repeat an unreadable image).
  // The number-sorted rest follows. Ordinals run across everything.
  const listItems = [];
  let ord = 0;
  if (freshRows.length > 0) {
    listItems.push({ type: 'fresh-label', key: 'fresh-label' });
    const groups = [];
    const byRef = new Map();
    for (const inv of freshRows) {
      const gkey = inv.photo_ref || `solo-${inv.id}`;
      let g = byRef.get(gkey);
      if (!g) {
        g = { ref: inv.photo_ref, rows: [] };
        byRef.set(gkey, g);
        groups.push(g);
      }
      g.rows.push(inv);
    }
    for (const g of groups) {
      if (g.ref) listItems.push({ type: 'photo', key: `ph-${g.ref}`, ref: g.ref });
      for (const inv of g.rows) listItems.push({ type: 'row', key: inv.id, inv, ordinal: ++ord });
    }
    if (restRows.length > 0) listItems.push({ type: 'rest-label', key: 'rest-label' });
  }
  for (const inv of restRows) listItems.push({ type: 'row', key: inv.id, inv, ordinal: ++ord });

  return (
    <div className="screen">
      <header className="app-header">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Назад
        </button>
        <div className="header-title">
          <h1>{employee.name}</h1>
          <span className="muted">
            {week.label} · {fmtDate(week.date)}
          </span>
        </div>
      </header>

      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          handleFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {cameraOpen && (
        <CameraCapture
          onCancel={() => setCameraOpen(false)}
          onError={(e) => onError(e)}
          onDone={(blobs) => {
            setCameraOpen(false);
            if (blobs.length > 0) handleFiles(blobs);
          }}
        />
      )}

      <section className="capture-block">
        <button
          className="btn btn-primary btn-big"
          disabled={Boolean(scanProgress)}
          onClick={() => (cameraSupported ? setCameraOpen(true) : cameraInputRef.current?.click())}
        >
          📷 Сфотографировать накладные
        </button>
        <button
          className="btn btn-secondary"
          disabled={Boolean(scanProgress)}
          onClick={() => galleryInputRef.current?.click()}
        >
          Выбрать из галереи
        </button>
        {visionReady && !scanProgress && (
          <p className="capture-hint">📸 Снимайте по 3–4 накладные — так распознаётся точнее</p>
        )}
        {!visionReady && (
          <p className="notice notice-warn">
            Распознавание фото не настроено (нет ключа API) — строки можно добавлять вручную.
          </p>
        )}
        {scanProgress && (
          <p className="notice notice-info">
            Распознаю фото {scanProgress.current} из {scanProgress.total}…
          </p>
        )}
        {scanNotice && <p className="notice notice-warn">{scanNotice}</p>}
      </section>

      <section className="card invoice-list">
        {invoices.length > 0 && (
          <div className="select-bar">
            {selectMode ? (
              <>
                <button
                  className="btn btn-ghost"
                  onClick={() =>
                    setSelectedIds(
                      selectedIds.size === invoices.length
                        ? new Set()
                        : new Set(invoices.map((i) => i.id))
                    )
                  }
                >
                  {selectedIds.size === invoices.length ? 'Снять все' : 'Выбрать все'}
                </button>
                <button
                  className="btn btn-danger-text"
                  disabled={selectedIds.size === 0}
                  onClick={deleteSelected}
                >
                  Удалить ({selectedIds.size})
                </button>
                <button className="btn btn-ghost" onClick={exitSelectMode}>
                  Отмена
                </button>
              </>
            ) : (
              <button className="btn btn-ghost" onClick={() => setSelectMode(true)}>
                Выбрать
              </button>
            )}
          </div>
        )}
        <div className="invoice-head">
          <span className="col-ord">{selectMode ? '' : '#'}</span>
          <span className="col-num">№ накладной</span>
          <span className="col-amount">Сумма</span>
          <span className="col-paid">Оплачено</span>
          <span className="col-x"></span>
        </div>
        {invoices.length === 0 && <p className="muted center">Пока нет накладных</p>}
        {listItems.map((it) => {
          if (it.type === 'fresh-label') {
            return (
              <div key={it.key} className="fresh-label">
                🆕 Новые с последнего фото — проверьте
              </div>
            );
          }
          if (it.type === 'rest-label') {
            return (
              <div key={it.key} className="rest-label">
                Остальные
              </div>
            );
          }
          if (it.type === 'photo') {
            return (
              <button
                key={it.key}
                type="button"
                className="fresh-photo"
                onClick={() => setPhotoView(it.ref)}
                title="Нажмите, чтобы увеличить"
              >
                <img src={photoUrl(it.ref)} alt="Фото накладных" />
              </button>
            );
          }
          const inv = it.inv;
          return (
            <InvoiceRow
              key={it.key}
              inv={inv}
              ordinal={it.ordinal}
              fresh={freshIds.has(inv.id) && !selectMode}
              selectMode={selectMode}
              selected={selectedIds.has(inv.id)}
              onToggleSelected={() => toggleSelected(inv.id)}
              onPatch={(patch) => patchInvoice(inv.id, patch)}
              onDelete={() => deleteInvoice(inv.id)}
              onShowPhoto={() => inv.photo_ref && setPhotoView(inv.photo_ref)}
            />
          );
        })}
        {!selectMode && (
          <button className="btn btn-ghost add-row-btn" onClick={addManualRow}>
            + Добавить строку
          </button>
        )}
        {invoices.length > 0 && (
          <div className="invoice-count">
            <span>Количество накладных</span>
            <b>{invoices.length}</b>
          </div>
        )}
      </section>

      <section className="card totals-block">
        <div className="total-line">
          <span>Сумма</span>
          <b>{fmt(sum)} ₽</b>
        </div>
        <div className="total-line">
          <span>50%</span>
          <b>{fmt(half)} ₽</b>
        </div>
      </section>

      <section className="card adjustments-block">
        <h2>Корректировки</h2>
        <h3>Постоянные</h3>
        {standing.map((adj) => (
          <div key={adj.id} className="adj-row">
            <span className="adj-label">− {adj.label}</span>
            <AmountInput
              value={adj.amount}
              onCommit={(v) => patchAdjustment(adj.id, { amount: v })}
            />
          </div>
        ))}

        <h3>Свои</h3>
        {custom.length === 0 && !showCustomForm && <p className="muted">Нет</p>}
        {custom.map((adj) => (
          <div key={adj.id} className="adj-row">
            <span className="adj-label">
              {adj.sign === '+' ? '+' : '−'} {adj.label}
              {adj.date && <span className="muted adj-date"> {fmtDate(adj.date)}</span>}
            </span>
            <AmountInput
              value={adj.amount}
              onCommit={(v) => patchAdjustment(adj.id, { amount: v })}
            />
            <button className="btn btn-ghost btn-x" onClick={() => deleteAdjustment(adj.id)}>
              ✕
            </button>
          </div>
        ))}
        {showCustomForm ? (
          <CustomAdjustmentForm
            onAdd={addCustomAdjustment}
            onCancel={() => setShowCustomForm(false)}
          />
        ) : (
          <button className="btn btn-ghost add-row-btn" onClick={() => setShowCustomForm(true)}>
            + Добавить
          </button>
        )}
      </section>

      <section className="payout-block">
        <span>К выплате</span>
        <b>{fmt(payout)} ₽</b>
      </section>

      <button className="btn btn-primary btn-big summary-btn" onClick={onSummary}>
        Итоговый лист →
      </button>

      {photoView && (
        <div className="photo-overlay" onClick={() => setPhotoView(null)}>
          <img src={photoUrl(photoView)} alt="Фото накладной" />
          <p className="muted center">Нажмите, чтобы закрыть</p>
        </div>
      )}
    </div>
  );
}

// Numeric input that commits on blur/Enter; avoids re-render churn while typing.
function AmountInput({ value, onCommit, className = '' }) {
  const [text, setText] = useState(String(value ?? ''));
  useEffect(() => {
    setText(String(value ?? ''));
  }, [value]);

  function commit() {
    const n = Math.round(Number(text.replace(/\s/g, '').replace(',', '.')) || 0);
    if (n !== value) onCommit(n);
    else setText(String(value ?? ''));
  }

  return (
    <input
      className={`input amount-input ${className}`}
      inputMode="numeric"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
    />
  );
}

function NumberInput({ value, onCommit }) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  useEffect(() => {
    setText(value === null || value === undefined ? '' : String(value));
  }, [value]);

  function commit() {
    const trimmed = text.trim();
    const n = trimmed === '' ? null : Math.round(Number(trimmed)) || null;
    if (n !== value) onCommit(n);
  }

  return (
    <input
      className="input number-input"
      inputMode="numeric"
      placeholder="№"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
    />
  );
}

function InvoiceRow({ inv, ordinal, fresh, selectMode, selected, onToggleSelected, onPatch, onDelete, onShowPhoto }) {
  const classes = ['invoice-row'];
  if (fresh) classes.push('row-fresh');
  if (inv.needs_review) classes.push('row-review');
  if (!inv.paid) classes.push('row-unpaid');
  if (selectMode && selected) classes.push('row-selected');

  // In select mode, tapping anywhere on the row (except its inputs) toggles it.
  function onRowClick(e) {
    if (!selectMode) return;
    if (e.target.closest('input, button')) return;
    onToggleSelected();
  }

  return (
    <div className={classes.join(' ')} onClick={onRowClick}>
      <div className="col-ord">
        {selectMode ? (
          <input
            type="checkbox"
            className="select-checkbox"
            checked={selected}
            onChange={onToggleSelected}
          />
        ) : (
          ordinal
        )}
      </div>
      <div className="col-num row-num-cell">
        {inv.photo_ref && (
          <button className="thumb-btn" onClick={onShowPhoto} title="Показать фото">
            🖼
          </button>
        )}
        <NumberInput
          value={inv.number}
          onCommit={(n) => onPatch({ number: n, needs_review: false })}
        />
      </div>
      <div className="col-amount">
        <AmountInput
          value={inv.amount}
          onCommit={(v) => onPatch({ amount: v, needs_review: false })}
        />
      </div>
      <div className="col-paid">
        <input
          type="checkbox"
          className="paid-checkbox"
          checked={Boolean(inv.paid)}
          onChange={(e) => onPatch({ paid: e.target.checked })}
        />
      </div>
      <div className="col-x">
        {selectMode ? null : inv.needs_review ? (
          <button
            className="btn btn-ghost btn-x confirm-btn"
            title="Подтвердить"
            onClick={() => onPatch({ needs_review: false })}
          >
            ✓
          </button>
        ) : (
          <button className="btn btn-ghost btn-x" title="Удалить" onClick={onDelete}>
            ✕
          </button>
        )}
      </div>
      {Boolean(inv.needs_review) && (
        <div className="row-note">Проверьте цифры (распознано неуверенно)</div>
      )}
      {!inv.paid && <div className="row-note row-note-danger">Нет штампа «ОПЛАЧЕНО» — не входит в сумму</div>}
    </div>
  );
}

function CustomAdjustmentForm({ onAdd, onCancel }) {
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');
  const [sign, setSign] = useState('-');

  function submit(e) {
    e.preventDefault();
    const a = Math.round(Number(amount.replace(/\s/g, '').replace(',', '.')) || 0);
    if (!label.trim()) return;
    onAdd(label.trim(), sign, a);
  }

  return (
    <form className="custom-adj-form" onSubmit={submit}>
      <input
        className="input"
        placeholder="Название (напр. Платье)"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        autoFocus
      />
      <div className="row-gap">
        <div className="sign-toggle">
          <button
            type="button"
            className={`btn ${sign === '-' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSign('-')}
          >
            − вычет
          </button>
          <button
            type="button"
            className={`btn ${sign === '+' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSign('+')}
          >
            + премия
          </button>
        </div>
        <input
          className="input amount-input"
          inputMode="numeric"
          placeholder="Сумма"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </div>
      <div className="row-gap">
        <button type="submit" className="btn btn-primary">
          Добавить
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  );
}
