import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmt, fmtDate } from '../util.js';

export default function Home({ weeks, weekId, onSelectWeek, onNewWeek, onDeleteWeek, onOpenEmployee, onError }) {
  const [overview, setOverview] = useState(null);
  const [allEmployees, setAllEmployees] = useState([]);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [editMode, setEditMode] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);

  const week = weeks.find((w) => w.id === weekId) || null;

  const load = useCallback(async () => {
    try {
      const employees = await api('/api/employees');
      setAllEmployees(employees);
      if (weekId) setOverview(await api(`/api/weeks/${weekId}/overview`));
      else setOverview(null);
    } catch (e) {
      onError(e);
    }
  }, [weekId, onError]);

  useEffect(() => {
    load();
  }, [load]);

  async function addEmployee(e) {
    e.preventDefault();
    const name = newName.trim();
    if (!name) return;
    try {
      await api('/api/employees', { method: 'POST', body: { name } });
      setNewName('');
      setAdding(false);
      await load();
    } catch (err) {
      onError(err);
    }
  }

  async function archiveEmployee(emp) {
    if (!confirm(`Убрать сотрудника «${emp.name}» из списка? Прошлые недели сохранятся.`)) return;
    try {
      await api(`/api/employees/${emp.id}/archive`, { method: 'POST' });
      await load();
    } catch (err) {
      onError(err);
    }
  }

  async function renameEmployee(emp) {
    const name = prompt('Имя сотрудника:', emp.name);
    if (!name || !name.trim() || name.trim() === emp.name) return;
    try {
      await api(`/api/employees/${emp.id}`, { method: 'PATCH', body: { name: name.trim() } });
      await load();
    } catch (err) {
      onError(err);
    }
  }

  async function deleteWeek() {
    if (!week) return;
    const total = overview?.total_invoices ?? 0;
    const name = `«${week.label} · ${fmtDate(week.date)}»`;
    const msg =
      total > 0
        ? `Удалить неделю ${name}? В ней ${total} накладн. — они будут удалены безвозвратно!`
        : `Удалить пустую неделю ${name}?`;
    if (!confirm(msg)) return;
    if (total > 0 && !confirm('Точно удалить? Отменить это будет нельзя.')) return;
    await onDeleteWeek();
  }

  const checks = overview?.checks;
  const checksCount = checks
    ? checks.duplicates.length + checks.missing.length + checks.unpaid.length
    : 0;

  return (
    <div className="screen">
      <header className="app-header">
        <h1>Расчёт зарплаты</h1>
        <button className="btn btn-ghost" onClick={() => setEditMode((v) => !v)}>
          {editMode ? 'Готово' : 'Изменить'}
        </button>
      </header>

      <section className="card week-picker">
        <label className="field-label" htmlFor="week-select">Неделя</label>
        <div className="week-row">
          <select
            id="week-select"
            className="select"
            value={weekId ?? ''}
            onChange={(e) => onSelectWeek(Number(e.target.value))}
          >
            {weeks.map((w) => (
              <option key={w.id} value={w.id}>
                {w.label} · {fmtDate(w.date)}
              </option>
            ))}
          </select>
          <button className="btn btn-secondary" onClick={onNewWeek}>
            + Новая
          </button>
          {editMode && (
            <button
              className="btn btn-ghost btn-danger-text btn-x week-delete-btn"
              title="Удалить неделю"
              onClick={deleteWeek}
            >
              🗑
            </button>
          )}
        </div>
      </section>

      <section className="employee-list">
        {(overview?.employees || []).map((emp) => (
          <div key={emp.id} className="card employee-card">
            <button className="employee-main" onClick={() => onOpenEmployee(emp.id)}>
              <div className="employee-name">{emp.name}</div>
              <div className="employee-meta muted">
                {emp.invoice_count > 0 ? (
                  <>
                    Накладных: {emp.invoice_count}
                    {emp.needs_review_count > 0 && (
                      <span className="badge badge-warn"> проверить: {emp.needs_review_count}</span>
                    )}
                    {emp.unpaid_count > 0 && (
                      <span className="badge badge-danger"> без оплаты: {emp.unpaid_count}</span>
                    )}
                  </>
                ) : (
                  'Накладных пока нет'
                )}
              </div>
              <div className="employee-payout">
                К выплате: <b>{fmt(emp.payout)} ₽</b>
              </div>
            </button>
            {editMode && (
              <div className="employee-actions">
                <button className="btn btn-ghost" onClick={() => renameEmployee(emp)}>
                  Переименовать
                </button>
                <button className="btn btn-ghost btn-danger-text" onClick={() => archiveEmployee(emp)}>
                  Убрать
                </button>
              </div>
            )}
          </div>
        ))}

        {adding ? (
          <form className="card add-form" onSubmit={addEmployee}>
            <input
              className="input"
              placeholder="Имя сотрудника"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
            <div className="row-gap">
              <button type="submit" className="btn btn-primary">
                Добавить
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>
                Отмена
              </button>
            </div>
          </form>
        ) : (
          <button className="btn btn-secondary btn-big add-employee-btn" onClick={() => setAdding(true)}>
            + Добавить сотрудника
          </button>
        )}
      </section>

      {week && checks && (
        <section className="card checks-panel">
          <button className="checks-header" onClick={() => setChecksOpen((v) => !v)}>
            <span>
              Проверки недели{' '}
              {checksCount > 0 ? (
                <span className="badge badge-warn">{checksCount}</span>
              ) : (
                <span className="badge badge-ok">всё в порядке</span>
              )}
            </span>
            <span className="chevron">{checksOpen ? '▲' : '▼'}</span>
          </button>
          {checksOpen && (
            <div className="checks-body">
              <h3>Повторы номеров</h3>
              {checks.duplicates.length === 0 ? (
                <p className="muted">Нет</p>
              ) : (
                checks.duplicates.map((d) => (
                  <p key={d.number} className="check-line">
                    № {d.number}:{' '}
                    {d.entries.map((en) => `${en.employee_name} (${fmt(en.amount)} ₽)`).join(', ')}
                  </p>
                ))
              )}
              <h3>Пропущенные номера</h3>
              {checks.missing.length === 0 ? (
                <p className="muted">Нет</p>
              ) : (
                <p className="check-line">
                  {checks.missing.join(', ')}
                  {checks.missing_truncated ? ' …' : ''}
                </p>
              )}
              <h3>Не оплачено</h3>
              {checks.unpaid.length === 0 ? (
                <p className="muted">Нет</p>
              ) : (
                checks.unpaid.map((u, i) => (
                  <p key={i} className="check-line">
                    {u.employee_name} — № {u.number ?? '?'} на {fmt(u.amount)} ₽
                  </p>
                ))
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
