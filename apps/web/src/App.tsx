import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { AppDialogHost } from './components/AppDialogHost'
import { AppShell } from './layout/AppShell'
import { CopyPage } from './pages/CopyPage'
import { DashPage } from './pages/DashPage'
import { ImagesPage } from './pages/ImagesPage'
import { NotesPage } from './pages/NotesPage'
import { TemplatesPage } from './pages/TemplatesPage'
import { WorkbenchPage } from './pages/WorkbenchPage'

export default function App() {
  return (
    <BrowserRouter>
      <AppDialogHost />
      <Routes>
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/workbench" replace />} />
          <Route path="/workbench" element={<WorkbenchPage />} />
          <Route path="/dash" element={<DashPage />} />
          <Route path="/copy" element={<CopyPage />} />
          <Route path="/competitors" element={<Navigate to="/copy" replace />} />
          <Route path="/images" element={<ImagesPage />} />
          <Route path="/google-images" element={<Navigate to="/images?tab=google" replace />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/notes" element={<NotesPage />} />
          <Route path="*" element={<Navigate to="/workbench" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
