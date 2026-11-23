import { Badge } from "../../../elements/index.js";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table.js";

export type PermissionDecision = {
  readonly id: string;
  readonly label: string;
  readonly allowed: boolean;
};

type PermissionDecisionTableProps = {
  readonly caption: string;
  readonly permissionHeading: string;
  readonly decisionHeading: string;
  readonly allowedLabel: string;
  readonly deniedLabel: string;
  readonly decisions: readonly PermissionDecision[];
};

/** Display authorization results supplied by the application. */
export function PermissionDecisionTable({
  caption,
  permissionHeading,
  decisionHeading,
  allowedLabel,
  deniedLabel,
  decisions,
}: PermissionDecisionTableProps) {
  return (
    <Table>
      <caption className="sr-only">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">{permissionHeading}</TableHead>
          <TableHead scope="col">{decisionHeading}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {decisions.map(({ id, label, allowed }) => (
          <TableRow key={id}>
            <th scope="row" className="px-2 py-2 text-start font-medium">
              {label}
            </th>
            <TableCell>
              <Badge variant={allowed ? "secondary" : "outline"}>{allowed ? allowedLabel : deniedLabel}</Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
