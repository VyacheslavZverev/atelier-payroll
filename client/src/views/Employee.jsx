import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, photoUrl } from '../api.js';
import { fmt, fmtDate, fileToDataUrl } from '../util.js';

export default function Employee({ weekId, employeeId, visionReady, onBack, onSummary, onError }) {
  const [data, setData] = useState(null); // { week, employee, invoices, adjustments, ... }
  const [scanProgress, setScanProgress] = useState(null); // { current, total }
  const [scanNotice, setScanNotice] = useState('');
  const [photoView, setPhotoView] = useState(null); // photo_ref shown full-screen
  const [showCustomForm, setShowCustomForm] = useState(false);
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

  // ---------------- photo capture ----------------

  async function handleFiles(fileList) {
    const files = [...fileList];
    if (files.length === 0) return;
    setScanNotice('');
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
        setData((d) => (d ? { ...d, invoices: [...d.invoices, ...res.invoices] } : d));
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

      <section className="capture-block">
        <button
          className="btn btn-primary btn-big"
          disabled={Boolean(scanProgress)}
          onClick={() => cameraInputRef.current?.click()}
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
        <div className="invoice-head">
          <span className="col-num">№ накладной</span>
          <span className="col-amount">Сумма</span>
          <span className="col-paid">Оплачено</span>
          <span className="col-x"></span>
        </div>
        {invoices.length === 0 && <p className="muted center">Пока нет накладных</p>}
        {invoices.map((inv) => (
          <InvoiceRow
            key={inv.id}
            inv={inv}
            onPatch={(patch) => patchInvoice(inv.id, patch)}
            onDelete={() => deleteInvoice(inv.id)}
            onShowPhoto={() => inv.photo_ref && setPhotoView(inv.photo_ref)}
          />
        ))}
        <button className="btn btn-ghost add-row-btn" onClick={addManualRow}>
          + Добавить строку
        </button>
      </section>

      <section className="card totals-block">
        <div className="total-line">
          <span>Сумма</span>
          <b>{fmt(sum)} ₽</b>
        </div>
        <div className="total-line">
          <span>Заработано</span>
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

function InvoiceRow({ inv, onPatch, onDelete, onShowPhoto }) {
  const classes = ['invoice-row'];
  if (inv.needs_review) classes.push('row-review');
  if (!inv.paid) classes.push('row-unpaid');

  return (
    <div className={classes.join(' ')}>
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
        {inv.needs_review ? (
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
