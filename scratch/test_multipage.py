import os
import sys

# Add the ETL directory to the system path
etl_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "shreyash", "ETL_GRP (1)", "ETL_GRP", "ETL_2", "ETL"))
if etl_dir not in sys.path:
    sys.path.append(etl_dir)

from bill_to_text import BillConverter
from main_extractor import MainExtractor

converter = BillConverter()

uploads_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "shreyash", "ETL_GRP (1)", "ETL_GRP", "ETL_2", "uploads"))

test_files = [
    "MultiPage_Invoice_Dmart_Style.pdf",
    "MultiPage_Invoice_Header_FirstPage_Only.pdf",
    "sample_bill_varied_items_multi_page.pdf"
]

output_lines = []

for filename in test_files:
    file_path = os.path.join(uploads_dir, filename)
    output_lines.append(f"\n========================================\nTESTING FILE: {filename}\n========================================")
    if not os.path.exists(file_path):
        output_lines.append(f"File not found: {file_path}")
        continue
    
    text, word_map = converter.convert(file_path)
    output_lines.append(f"Text length: {len(text)}, Word map entries: {len(word_map)}")
    
    extractor = MainExtractor(text)
    items = extractor.extract_line_items(word_map)
    output_lines.append(f"Extracted {len(items)} items:")
    for idx, item in enumerate(items):
        output_lines.append(f"  Item {idx+1}: {item}")

with open("scratch/test_output.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(output_lines))
print("Results written to scratch/test_output.txt")
