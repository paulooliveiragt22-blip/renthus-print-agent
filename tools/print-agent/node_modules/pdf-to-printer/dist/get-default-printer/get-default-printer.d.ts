export interface Printer {
    deviceId: string;
    name: string;
}
declare function getDefaultPrinter(): Promise<Printer | null>;
export default getDefaultPrinter;
