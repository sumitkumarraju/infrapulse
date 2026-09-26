import { Route, Routes } from 'react-router'
import { DesktopShell } from '@/app/DesktopShell'
import { MobileShell } from '@/app/MobileShell'
import { Placeholder } from '@/app/Placeholder'
import { Budget } from '@/routes/Budget'
import { Command } from '@/routes/Command'
import { Escalations } from '@/routes/Escalations'
import { Forecast } from '@/routes/Forecast'
import { Landing } from '@/routes/Landing'
import { Reports } from '@/routes/Reports'
import { Styleguide } from '@/routes/Styleguide'
import { WorkOrders } from '@/routes/WorkOrders'
import { Drive } from '@/routes/app/Drive'
import { Impact } from '@/routes/app/Impact'
import { ReportPothole } from '@/routes/app/ReportPothole'
import { Trip } from '@/routes/app/Trip'

export function AppRoutes() {
  return (
    <Routes>
      {/* The landing page is full-bleed 3D, so it sits outside the shell. */}
      <Route index element={<Landing />} />

      <Route element={<DesktopShell />}>
        <Route path="styleguide" element={<Styleguide />} />
        <Route path="command" element={<Command />} />
        <Route path="forecast" element={<Forecast />} />
        <Route path="budget" element={<Budget />} />
        <Route path="work-orders" element={<WorkOrders />} />
        <Route path="reports" element={<Reports />} />
        <Route path="escalations" element={<Escalations />} />
        <Route path="*" element={<Placeholder title="Not found" phase="—" />} />
      </Route>

      {/* Driver and citizen screens: light theme, bottom tabs, phone sensors. */}
      <Route path="app" element={<MobileShell />}>
        <Route index element={<Drive />} />
        <Route path="trip" element={<Trip />} />
        <Route path="report" element={<ReportPothole />} />
        <Route path="impact" element={<Impact />} />
      </Route>
    </Routes>
  )
}
