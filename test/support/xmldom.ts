import { DOMParser } from "@xmldom/xmldom";
import type { XNode, XmlParser } from "../../src/caldav/xml";

/** xmldom stands in for the browser's DOMParser in Node. */
export const xmldomParser: XmlParser = (xml) =>
  new DOMParser().parseFromString(xml, "application/xml").documentElement as unknown as XNode;
