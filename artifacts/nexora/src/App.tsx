import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Administration from '@/pages/administration';
import ComingSoon from '@/pages/coming-soon';
import DeviceDetail from '@/pages/device-detail';
import Devices from '@/pages/devices';
import Overview from '@/pages/overview';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Overview} />
        <Route path="/devices" component={Devices} />
        <Route path="/devices/:deviceId" component={DeviceDetail} />
        <Route path="/administration" component={Administration} />
        <Route path="/alerts" component={ComingSoon} />
        <Route path="/automation" component={ComingSoon} />
        <Route path="/patch-management" component={ComingSoon} />
        <Route path="/software" component={ComingSoon} />
        <Route path="/network" component={ComingSoon} />
        <Route path="/tickets" component={ComingSoon} />
        <Route path="/reports" component={ComingSoon} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
