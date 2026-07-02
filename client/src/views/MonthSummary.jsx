import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmt, monthLabel } from '../util.js';

// Owner-only monthly analytics: each employee's total "50%" across all weeks of
// the month. View-only (no print/export).
export default function MonthSummary({ ym, onBack, onError }) {
  const [data, setData] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/api/months/${ym}/analytics`));
    } catch (e) {
      onError(e);
    }
  }, [ym, onError]);

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

  const grandTotal = data.employees.reduce((acc, e) => acc + e.total_half, 0);

  return (
    <div className="screen">
      <header className="app-header">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Назад
        </button>
        <div className="header-title">
          <h1>Итоги месяца</h1>
          <span className="muted">{monthLabel(data.month)}</span>
        </div>
      </header>

      <section className="card">
        <p className="muted month-weeks">
          Недель в месяце: {data.weeks.length}
          {data.weeks.length > 0 && <> · {data.weeks.map((w) => w.label).join(', ')}</>}
        </p>
      </section>

      {data.employees.length === 0 ? (
        <p className="muted center">За этот месяц данных нет</p>
      ) : (
        <section className="month-list">
          {data.employees.map((e) => (
            <div key={e.id} className="card month-emp">
              <div className="month-emp-head">
                <span className="month-emp-name">
                  {e.name}
                  {e.status === 'archived' && <span className="muted"> (архив)</span>}
                </span>
                <b className="month-emp-total">{fmt(e.total_half)} ₽</b>
              </div>
              <div className="month-emp-weeks">
                {e.weeks.map((w) => (
                  <div key={w.week_id} className="month-week-line">
                    <span className="muted">{w.label}</span>
                    <span>{fmt(w.half)} ₽</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      <section className="payout-block month-grand">
        <span>Всего за месяц (50%)</span>
        <b>{fmt(grandTotal)} ₽</b>
      </section>
    </div>
  );
}
