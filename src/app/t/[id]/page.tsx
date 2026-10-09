import { notFound } from "next/navigation";
import { Table } from "./Table";

export default async function TablePage({ params, searchParams }: PageProps<"/t/[id]">) {
  const { id } = await params;
  if (!/^[tp]-[a-z0-9]{6}$/.test(id)) notFound();
  const query = await searchParams;
  // ?sit: came from a Join button, so take a seat on arrival. ?new: just opened this table.
  return <Table id={id} sitOnArrival={query.sit !== undefined || query.new !== undefined} justCreated={query.new !== undefined} />;
}
