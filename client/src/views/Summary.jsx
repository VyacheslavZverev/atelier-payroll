import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmt, fmtDate } from '../util.js';

export default function Summary({ weekId, employeeId, shopName, onBack, onError }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState('');
  const sheetRef = useRef(null);

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

  if (!data) {
    return (
      <div className="screen">
        <p className="muted center">Загрузка…</p>
      </div>
    );
  }

  const { week, employee, invoices, adjustments, sum, half, payout } = data;

  // Same order as the review screen: by invoice number ascending, unfilled
  // rows last. Unpaid invoices stay marked inline rather than grouped.
  const orderedInvoices = [...invoices].sort((a, b) => {
    if (a.number == null && b.number == null) return a.id - b.id;
    if (a.number == null) return 1;
    if (b.number == null) return -1;
    return a.number - b.number;
  });

  // Long single-column lists waste an A4 sheet, so split into balanced
  // columns once there are many rows. Aim for ~22 rows per column, capped at
  // 3 columns to stay legible on A4.
  const ROWS_PER_COLUMN = 22;
  const columnCount = Math.min(3, Math.max(1, Math.ceil(orderedInvoices.length / ROWS_PER_COLUMN)));
  const perColumn = Math.ceil(orderedInvoices.length / columnCount);
  const invoiceColumns = Array.from({ length: columnCount }, (_, i) =>
    orderedInvoices.slice(i * perColumn, (i + 1) * perColumn)
  );

  function summaryText() {
    const lines = [];
    lines.push(shopName);
    lines.push(`${employee.name} — ${week.label} (${fmtDate(week.date)})`);
    lines.push('');
    for (const inv of orderedInvoices) {
      const mark = inv.paid ? '' : ' (без оплаты)';
      lines.push(`№ ${inv.number ?? '—'}${mark}\t${fmt(inv.amount)}`);
    }
    lines.push('');
    lines.push(`Количество накладных: ${orderedInvoices.length}`);
    lines.push(`Сумма: ${fmt(sum)}`);
    lines.push(`50%: ${fmt(half)}`);
    for (const adj of adjustments) {
      if (adj.amount === 0) continue;
      const datePart = adj.type === 'custom' && adj.date ? ` (${fmtDate(adj.date)})` : '';
      lines.push(`${adj.sign === '+' ? '+' : '−'} ${adj.label}${datePart}: ${fmt(adj.amount)}`);
    }
    lines.push(`К выплате: ${fmt(payout)} ₽`);
    return lines.join('\n');
  }

  async function copyText() {
    setBusy('copy');
    try {
      await navigator.clipboard.writeText(summaryText());
      alert('Текст скопирован');
    } catch {
      // Fallback for older WebViews without clipboard API permission
      const ta = document.createElement('textarea');
      ta.value = summaryText();
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      alert('Текст скопирован');
    } finally {
      setBusy('');
    }
  }

  async function saveImage() {
    setBusy('img');
    try {
      const { default: html2canvas } = await import('html2canvas');
      // Capture at a fixed, A4-proportioned width so the saved image looks the
      // same whether she taps from a narrow phone or a desktop. Each column
      // needs ~300px to stay legible; restore the live width afterwards.
      const sheet = sheetRef.current;
      const exportWidth = 200 + columnCount * 300;
      const prevWidth = sheet.style.width;
      sheet.style.width = `${exportWidth}px`;
      let canvas;
      try {
        canvas = await html2canvas(sheet, {
          scale: 2,
          backgroundColor: '#ffffff',
          width: exportWidth,
          windowWidth: exportWidth + 40
        });
      } finally {
        sheet.style.width = prevWidth;
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const fileName = `${employee.name} ${week.label}.png`.replace(/[\\/:*?"<>|]/g, '_');
      const file = blob && new File([blob], fileName, { type: 'image/png' });
      // Prefer the native share sheet on phones; fall back to a download.
      if (file && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return;
        } catch (e) {
          if (e.name === 'AbortError') return; // user closed the share sheet
        }
      }
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = fileName;
      a.click();
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="screen summary-screen">
      <header className="app-header no-print">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Назад
        </button>
        <div className="row-gap">
          <button className="btn btn-secondary" disabled={busy !== ''} onClick={copyText}>
            {busy === 'copy' ? '…' : 'Скопировать текст'}
          </button>
          <button className="btn btn-primary" disabled={busy !== ''} onClick={saveImage}>
            {busy === 'img' ? '…' : 'Сохранить как картинку'}
          </button>
        </div>
      </header>

      <div className="sheet" ref={sheetRef}>
        <div className="sheet-header">
          <div className="sheet-shop">{shopName}</div>
          <div className="sheet-employee">{employee.name}</div>
          <div className="sheet-week">
            {week.label} · {fmtDate(week.date)}
          </div>
        </div>

        <div className={`sheet-columns cols-${columnCount}`}>
          {invoiceColumns.map((col, ci) => (
            <table className="sheet-table" key={ci}>
              <thead>
                <tr>
                  <th>№ накладной</th>
                  <th className="num">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {col.map((inv) => (
                  <tr key={inv.id} className={inv.paid ? '' : 'sheet-unpaid'}>
                    <td>
                      {inv.number ?? '—'}
                      {!inv.paid && ' (без оплаты)'}
                    </td>
                    <td className="num">{inv.paid ? fmt(inv.amount) : `(${fmt(inv.amount)})`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        </div>

        <div className="sheet-count">
          <span>Количество накладных</span>
          <b>{orderedInvoices.length}</b>
        </div>

        <div className="sheet-totals">
          <div className="sheet-line">
            <span>Сумма</span>
            <b>{fmt(sum)}</b>
          </div>
          <div className="sheet-line sheet-earned">
            <span>50%</span>
            <b>{fmt(half)}</b>
          </div>
          {adjustments
            .filter((adj) => adj.amount !== 0)
            .map((adj) => (
              <div key={adj.id} className="sheet-line sheet-adj">
                <span>
                  {adj.sign === '+' ? '+' : '−'} {adj.label}
                  {adj.type === 'custom' && adj.date && (
                    <span className="sheet-date"> {fmtDate(adj.date)}</span>
                  )}
                </span>
                <b>{fmt(adj.amount)}</b>
              </div>
            ))}
          <div className="sheet-line sheet-payout">
            <span>К выплате</span>
            <b>{fmt(payout)} ₽</b>
          </div>
        </div>
      </div>
    </div>
  );
}
