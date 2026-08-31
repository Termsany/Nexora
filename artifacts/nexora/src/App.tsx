import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { OrganizationScopeProvider, SessionProvider, useSession } from '@/lib/session';
import NotFound from '@/pages/not-found';
import Administration from '@/pages/administration';
import ComingSoon from '@/pages/coming-soon';
import DeviceDetail from '@/pages/device-detail';
import Devices from '@/pages/devices';
import Login from '@/pages/login';
import Organizations from '@/pages/organizations';
import OrganizationDetail from '@/pages/organization-detail';
import Overview from '@/pages/overview';
import Alerts from '@/pages/alerts';
import Software from '@/pages/software';
import Audit from '@/pages/audit';
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
        <Route path="/organizations" component={Organizations} />
        <Route path="/organizations/:organizationId" component={OrganizationDetail} />
        <Route path="/administration" component={Administration} />
        <Route path="/alerts" component={Alerts} />
        <Route path="/automation" component={ComingSoon} />
        <Route path="/patch-management" component={ComingSoon} />
        <Route path="/software" component={Software} />
        <Route path="/audit" component={Audit} />
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

/**
 * Shows the console only to a signed-in principal.
 *
 * This gate is a user-experience convenience, not the security boundary: every
 * API route independently establishes its own tenant context and refuses
 * anonymous or out-of-scope requests, so bypassing this component in the
 * browser reveals nothing.
 */
function AuthenticatedApp() {
  const { session, isLoading } = useSession();

  if (isLoading) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background">
        <LoaderCircle size={24} className="animate-spin text-accent" />
      </div>
    );
  }
  if (!session?.authenticated) return <Login />;
  return (
    <OrganizationScopeProvider>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
    </OrganizationScopeProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <TooltipProvider>
          <AuthenticatedApp />
          <Toaster />
        </TooltipProvider>
      </SessionProvider>
    </QueryClientProvider>
  );
}

export default App;
