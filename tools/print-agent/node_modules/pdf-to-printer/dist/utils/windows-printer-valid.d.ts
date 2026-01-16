import { Printer } from "../get-default-printer/get-default-printer";
export default function isValidPrinter(printer: string): {
    isValid: boolean;
    printerData: Printer;
};
