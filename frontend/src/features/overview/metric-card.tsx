import { ArrowUpRight, type LucideIcon, UsersRound } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function MetricCard({
  label,
  value,
  detail,
  tone,
  icon: Icon,
  trend,
}: {
  readonly label: string;
  readonly value: string;
  readonly detail: string;
  readonly tone: string;
  readonly icon: LucideIcon;
  readonly trend?: string;
}) {
  return (
    <Card className="metric-card">
      <CardHeader className="metric-header">
        <div>
          <p className="metric-label">{label}</p>
          <strong className="metric-value">{value}</strong>
        </div>
        <span className={`metric-icon ${tone}`}>
          <Icon aria-hidden="true" />
        </span>
      </CardHeader>
      <CardContent className="metric-foot">
        <span>{detail}</span>
        {trend && (
          <span className="metric-trend">
            <ArrowUpRight aria-hidden="true" />
            {trend}
          </span>
        )}
      </CardContent>
    </Card>
  );
}
