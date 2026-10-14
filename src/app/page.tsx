import Workspace from '../components/workspace';
import { getConfig } from '../config';

export const dynamic = 'force-dynamic';

export default function Home() {
  const config = getConfig();
  return <Workspace demo={process.env.DEMO_MODE === '1'} modelProvider={config.modelProvider} />;
}
