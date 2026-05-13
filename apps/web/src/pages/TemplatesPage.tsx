import { useCallback, useEffect, useState } from 'react'
import { apiDelete, apiGet, apiPatch, apiPost, type Template } from '../lib/api'

type EditorState =
  | null
  | 'new'
  | { mode: 'edit'; row: Template }

const emptyForm = {
  name: '',
  scenario: '',
  structure_description: '',
  enabled: true,
}

export function TemplatesPage() {
  const [items, setItems] = useState<Template[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [editor, setEditor] = useState<EditorState>(null)
  const [form, setForm] = useState(emptyForm)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      setLoadErr(null)
      const rows = await apiGet<Template[]>('/api/templates')
      setItems(rows)
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const openNew = () => {
    setForm(emptyForm)
    setEditor('new')
  }

  const openEdit = (row: Template) => {
    setForm({
      name: row.name,
      scenario: row.scenario,
      structure_description: row.structure_description,
      enabled: row.enabled,
    })
    setEditor({ mode: 'edit', row })
  }

  const closeEditor = () => {
    setEditor(null)
  }

  const saveEditor = async () => {
    const name = form.name.trim()
    if (!name) return
    setSaving(true)
    try {
      if (editor === 'new') {
        await apiPost<Template>('/api/templates', {
          name,
          scenario: form.scenario,
          structure_description: form.structure_description,
          enabled: form.enabled,
          copy_metadata: {},
        })
      } else if (editor && typeof editor === 'object') {
        await apiPatch<Template>(`/api/templates/${editor.row.id}`, {
          name,
          scenario: form.scenario,
          structure_description: form.structure_description,
          enabled: form.enabled,
        })
      }
      closeEditor()
      await load()
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const duplicate = async (row: Template) => {
    try {
      await apiPost<Template>(`/api/templates/${row.id}/duplicate`, {})
      await load()
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }

  const toggleEnabled = async (row: Template) => {
    try {
      await apiPatch<Template>(`/api/templates/${row.id}`, { enabled: !row.enabled })
      await load()
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = async (row: Template) => {
    if (!window.confirm(`删除模版「${row.name}」？`)) return
    try {
      await apiDelete(`/api/templates/${row.id}`)
      await load()
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="mx-auto max-w-5xl" data-feature="templates">
      <div className="mb-6 flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <p className="text-xs text-slate-500">
            用于「文案生成与管理」的模版来源；支持启用/停用与版本备注。
          </p>
        </div>
        <button
          type="button"
          id="btn-new-template"
          className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark"
          onClick={openNew}
        >
          新建模版
        </button>
      </div>

      {loadErr ? (
        <p className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">{loadErr}</p>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((t) => (
          <div
            key={t.id}
            className={`flex flex-col rounded-xl border border-slate-200 bg-white p-4 ${t.enabled ? '' : 'opacity-70'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-medium text-slate-900">{t.name}</span>
              {t.enabled ? (
                <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium uppercase text-emerald-600">
                  启用
                </span>
              ) : (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-slate-400">
                  停用
                </span>
              )}
            </div>
            <p className="mt-2 flex-1 text-xs text-slate-500">
              {t.structure_description ? `结构：${t.structure_description}` : '（无结构说明）'}
              {t.scenario ? ` ${t.scenario}` : ''}
            </p>
            <div className="mt-3 flex flex-wrap gap-3 text-xs">
              <button type="button" className="font-medium text-brand hover:underline" onClick={() => openEdit(t)}>
                编辑
              </button>
              <button type="button" className="text-slate-500 hover:text-slate-700" onClick={() => void duplicate(t)}>
                复制
              </button>
              <button type="button" className="text-slate-400 hover:text-slate-600" onClick={() => void toggleEnabled(t)}>
                {t.enabled ? '停用' : '启用'}
              </button>
              <button type="button" className="text-slate-400 hover:text-rose-600" onClick={() => void remove(t)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {editor ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onClick={(e) => e.target === e.currentTarget && closeEditor()}
        >
          <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="absolute right-4 top-4 text-xl leading-none text-slate-400 hover:text-slate-600"
              onClick={closeEditor}
              aria-label="关闭"
            >
              &times;
            </button>
            <h2 className="mb-4 text-lg font-semibold text-slate-900">
              {editor === 'new' ? '新建模版' : '编辑模版'}
            </h2>
            <div className="space-y-3 text-sm">
              <div>
                <label className="mb-1 block text-xs text-slate-500">名称</label>
                <input
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  maxLength={200}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">适用场景</label>
                <textarea
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  rows={2}
                  value={form.scenario}
                  onChange={(e) => setForm((f) => ({ ...f, scenario: e.target.value }))}
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-slate-500">段落结构说明</label>
                <textarea
                  className="w-full rounded-lg border border-slate-200 px-3 py-2"
                  rows={3}
                  value={form.structure_description}
                  onChange={(e) => setForm((f) => ({ ...f, structure_description: e.target.value }))}
                />
              </div>
              <label className="flex items-center gap-2 text-slate-700">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
                  className="rounded border-slate-300"
                />
                启用（文案页仅拉取启用中的模版）
              </label>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
                onClick={closeEditor}
              >
                取消
              </button>
              <button
                type="button"
                className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-dark disabled:opacity-50"
                disabled={saving || !form.name.trim()}
                onClick={() => void saveEditor()}
              >
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
