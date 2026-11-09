import { ArrowUpRight, CircleDashed } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

type PlaceholderPageProps = {
  readonly title: string;
  readonly description: string;
};

export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <main className="placeholder-page">
      <div className="eyebrow">
        <span className="eyebrow-mark" />
        DOOMFORGE <span className="eyebrow-separator">/</span> WORKSPACE
      </div>
      <h1>{title}</h1>
      <p className="placeholder-intro">{description}</p>
      <Card className="placeholder-card">
        <CardHeader>
          <div>
            <CardTitle>{title} workspace</CardTitle>
            <CardDescription>
              This area is connected to the shared navigation and session
              foundation.
            </CardDescription>
          </div>
          <CircleDashed className="placeholder-icon" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <p>
            Page-specific tools and live records will appear here when this
            workspace module is connected.
          </p>
          <Link className="placeholder-link" to="/">
            Return to overview <ArrowUpRight aria-hidden="true" />
          </Link>
        </CardContent>
      </Card>
    </main>
  );
}
