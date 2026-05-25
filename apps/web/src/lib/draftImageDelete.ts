import type { DraftImage } from './api'
import { appConfirm } from './appDialog'

/** 删除图稿前确认；被组合草稿引用时需二次说明（服务端会同步解除快照引用）。 */
export async function confirmDeleteDraftImage(img: DraftImage): Promise<boolean> {
  if (img.composed_snapshot_locked) {
    return appConfirm(
      '该图稿被「笔记管理」中的组合草稿引用。删除后将从相关草稿快照中移除该图，并永久删除文件。是否继续？',
      { title: '删除图稿', danger: true, confirmLabel: '删除' },
    )
  }
  return appConfirm('确定删除这张图稿？', {
    title: '删除图稿',
    danger: true,
    confirmLabel: '删除',
  })
}
