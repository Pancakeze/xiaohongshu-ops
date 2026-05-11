import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppShell } from './layout/AppShell'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { WorkbenchPage } from './pages/WorkbenchPage'

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/workbench" replace />} />
          <Route path="/workbench" element={<WorkbenchPage />} />
          <Route path="/dash" element={<PlaceholderPage title="总览" />} />
          <Route path="/copy" element={<PlaceholderPage title="文案生成与管理" />} />
          <Route path="/images" element={<PlaceholderPage title="图片生成与管理" />} />
          <Route path="/templates" element={<PlaceholderPage title="模版管理" />} />
          <Route path="/notes" element={<PlaceholderPage title="笔记管理" />} />
          <Route path="*" element={<Navigate to="/workbench" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
